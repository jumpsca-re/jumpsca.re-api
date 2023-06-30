import express from 'express';
import RequiredProperties from "../../util/middleware/RequiredProperties.js";
import Reply from "../../classes/Reply/Reply.js";
import Database from "../../db.js";
import NotFoundReply from "../../classes/Reply/NotFoundReply.js";
import isAvailable, {IAvailabilityResponse} from "../../util/isAvailable.js";
import BadRequestReply from "../../classes/Reply/BadRequestReply.js";
import {stripe, stripeWebhook} from "../../index.js";
import {Types} from "mongoose";
import {emailRegex} from "../../schemas/userSchema.js";
import tr46 from "tr46";
import ServerErrorReply from "../../classes/Reply/ServerErrorReply.js";

const router = express.Router();

const database = new Database();


/**
 * Fulfill orders
 * Stripe sends a POST request to this endpoint when a checkout session is completed
 * Creates addresses related to the order and the user if they don't already exist
 */
router.post("/checkout/fulfill", async (req, res) => {
    console.log("Checkout fulfill")
    // Receive stripe webhook
    const payload = req.body;
    const sig = req.headers['stripe-signature'];

    let event;

    try {
        // Verify the event came from Stripe
        event = stripe.webhooks.constructEvent(payload, sig, stripeWebhook);
        // Only handle checkout.session.completed events, others are not relevant
        if (event.type === 'checkout.session.completed') {
            console.log("Checkout session completed")
            // Retrieve the session. If you require line items in the response, you may include them by expanding line_items.
            const sessionWithLineItems = await stripe.checkout.sessions.retrieve(
                event.data.object.id,
                {
                    expand: ['line_items'],
                }
            );

            if (sessionWithLineItems.payment_status !== "paid") {
                console.error(`Checkout session completed but payment status is not paid. Session ID ${sessionWithLineItems.id}`)
                return res.status(400).end();
            }
            const lineItems = sessionWithLineItems.line_items;

            // Create address

            if (!lineItems) return res.status(400).end();

            console.log("Creating addresses")
            let knownOwner
            let generatedOwner = new Types.ObjectId();

            // Theoretically the only way this could happen is if the same new user buys two addresses in two separate transactions
            // and one of them is fulfilled before the other. This is unlikely to happen, but it's possible.
            // Normally users would be logged in when they buy addresses, so this shouldn't be an issue.
            // ... i think
            let existingUser = await database.User.findOne({email: sessionWithLineItems.customer_email})
            if (existingUser) {
                knownOwner = existingUser._id;
            }

            // Iterate through line items and create addresses
            // Usually there will only be one line item, but JUST IN CASE multiple are supported
            let addressNames : string[] = [];
            try {
                for (const purchasedAddress of lineItems.data) {
                    console.log("purchasedAddress", purchasedAddress)
                    if (!purchasedAddress.price?.product) {
                        console.error(`No product associated with line item? Line item ID ${purchasedAddress.id}`)
                        return res.status(400).end();
                    }
                    if (!purchasedAddress?.quantity) {
                        console.error(`No quantity associated with line item? Line item ID ${purchasedAddress.id}`)
                        return res.status(400).end();
                    }
                    const product = await stripe.products.retrieve(purchasedAddress.price.product as string);
                    console.log("product", product)

                    // If the address already exists, update the expiration date
                    let existingAddress = await database.Address.findOne({name: tr46.toASCII(product.metadata.address, {processingOption: "transitional"})})
                    if (existingAddress) {
                        console.log("Address already exists, updating expiration date")
                        existingAddress.expiresAt = new Date(existingAddress.expiresAt.getTime() + purchasedAddress.quantity * 365 * 24 * 60 * 60 * 1000);
                        await existingAddress.save();
                        continue;
                    }

                    let owner = generatedOwner;
                    if (product.metadata.owner) {
                        // If we know the owner, use that
                        owner = new Types.ObjectId(product.metadata.owner)
                    }
                    if (knownOwner) owner = knownOwner

                    const addressExpiration = purchasedAddress.quantity * 365 * 24 * 60 * 60 * 1000;
                    let address = new database.Address({
                        name: tr46.toASCII(product.metadata.address, {processingOption: "transitional"}),
                        owner,
                        expiresAt: new Date(Date.now() + addressExpiration)
                    })

                    addressNames.push(product.metadata.address);
                    if (product.metadata.owner) {
                        knownOwner = new Types.ObjectId(product.metadata.owner);
                    }

                    await address.save();
                }

                if (!knownOwner) {
                    // Buyer is a new user, create an account
                    console.log("Creating new user")
                    let user = new database.User({
                        _id: generatedOwner, // Use the ID that was linked to the addresses
                        displayName: addressNames[0], // They can change this later
                        email: sessionWithLineItems.customer_email, // This was supplied by us, so we know it is the one they want to use
                    })
                    // Note the lack of password, this means they can only log in with a magic link
                    // We can prompt them to set a password later
                    await user.save();
                }

                return res.status(200).end();
            } catch (e) {
                console.error("Error creating addresses", e)
                // TODO: If there are issues with this ever, implement refunds https://stripe.com/docs/api/refunds/create
                return res.status(500).end();
            }
        } else {
            // Unexpected event type
            console.error(`Unhandled event type ${event.type}`)
            return res.status(400).end();
        }
    } catch (err : any) {
        console.error(err)
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
})

router.get("/checkout/session", async (req, res) => {
    if (!req.query.session) return res.reply(new BadRequestReply("Specify session in query"))
    if (req.query.session.length > 66) return res.reply(new BadRequestReply("Session ID must be at most 66 characters"))
    let session
    try {
        session = await stripe.checkout.sessions.retrieve(req.query.session, {
            expand: ['line_items'],
        });
    } catch (e : any) {
        if (e.message.startsWith("No such checkout.session")) {
            return res.reply(new NotFoundReply("Session not found"))
        }
        console.error(e)
        return res.reply(new ServerErrorReply("Failed to fetch session"))
    }
    if (!session) return res.reply(new NotFoundReply());

    try {
        const lineItems = session.line_items;
        if (!lineItems) return
        for (const lineItem of lineItems.data) {
            if (!lineItem.price?.product) {
                console.error(`No product associated with line item? Line item ID ${lineItem.id}`)
                return res.reply(new ServerErrorReply("ERR_NO_PROD: Product missing from line item"))
            }
            if (!lineItem?.quantity) {
                console.error(`No quantity associated with line item? Line item ID ${lineItem.id}`)
                return res.reply(new ServerErrorReply("ERR_NO_QTY: Quantity missing from line item"))
            }
            // TODO: expand the type or whatever
            (lineItem as any).product = await stripe.products.retrieve(lineItem.price.product as string)
        }
        return res.reply(new Reply({
            response: {
                message: "Session found",
                session: {
                    lineItems: lineItems.data.map((lineItem : any) => {
                        return {
                            address: lineItem.product.metadata.address,
                            renewal: !!lineItem.product.metadata.renewal,
                            quantity: lineItem.quantity,
                            total: lineItem.amount_total,
                            subtotal: lineItem.amount_subtotal,
                            tax: lineItem.amount_tax
                        }
                    }),
                    total: session.amount_total,
                    subtotal: session.amount_subtotal,
                    tax: session.total_details?.amount_tax,
                    discount: session.total_details?.amount_discount,
                    currency: session.currency
                }
            }
        }))
    } catch (e)
    {
        console.error(e);
        // TODO: If this causes issues... i have no idea, i dont think refunding here makes sense
        return new ServerErrorReply();
    }

})

router.post("/checkout/:address", RequiredProperties([
    {
        property: "email",
        type: "string",
        regex: emailRegex
    }
]), async (req, res) => {
    let addressAvailability : IAvailabilityResponse = await isAvailable(tr46.toASCII(req.params.address, { processingOption: "transitional" }));
    if (addressAvailability.address !== false) return res.reply(new BadRequestReply("Address already registered"));

    const stripeSession = await stripe.checkout.sessions.create({
        line_items: [
            {
                price_data: {
                    currency: "eur",
                    unit_amount: 200,
                    product_data: {
                        name: `${req.params.address}.jumpsca.re`,
                        metadata: {
                            address: req.params.address
                        }
                    }
                },
                quantity: req.body.years || 1,
                adjustable_quantity: {
                    enabled: true,
                    minimum: 1,
                    maximum: 10
                }
            }
        ],
        customer_email: req.body.email,
        automatic_tax: {
            enabled: true
        },
        success_url: "https://jumpsca.re/checkout/success?session={CHECKOUT_SESSION_ID}",
        cancel_url: "https://jumpsca.re/checkout/cancel",
        mode: "payment"
    })
    res.reply(new Reply({
        response: {
            message: "Stripe session created",
            redirect: stripeSession.url
        }
    }))
})

router.post("/renew/:address", RequiredProperties([
    {
        property: "years",
        type: "number",
        min: 1,
        max: 10
    }
]),/* Auth, */ async (req, res) => {

    // TODO: Verify that the address is owned by the user
    req.user = {}
    req.user.email = "emilia@jumpsca.re"

    let address = await database.Address.findOne({name: req.params.address});
    if (!address) return res.reply(new NotFoundReply("Address not found"));

    const stripeSession = await stripe.checkout.sessions.create({
        line_items: [
            {
                price_data: {
                    currency: "eur",
                    unit_amount: 200,
                    product_data: {
                        name: `${req.params.address}.jumpsca.re Renewal for ${req.body.years} years`,
                        metadata: {
                            address: req.params.address,
                            renewal: "yes"
                        }
                    }
                },
                quantity: req.body.years,
                adjustable_quantity: {
                    enabled: true,
                    minimum: 1,
                    maximum: 10
                }
            }
        ],
        customer_email: req.user.email,
        automatic_tax: {
            enabled: true
        },
        success_url: "https://jumpsca.re/renewal/success?session={CHECKOUT_SESSION_ID}",
        cancel_url: "https://jumpsca.re/renewal/cancel",
        mode: "payment"
    })
    res.reply(new Reply({
        response: {
            message: "Stripe session created",
            redirect: stripeSession.url
        }
    }))
})

router.get("/:address", async (req, res) => {
    // This is the most ridiculous if statement
    // Basically url.domainToASCII turns numbers into ipv4 addresses https://github.com/nodejs/node/issues/41343
    // This is apparently a feature, so here is a workaround:
    // Check if the address as a number is NaN, if it is not skip punycode conversion
    /*if (isNaN(Number(req.params.address))) */req.params.address = tr46.toASCII(req.params.address.trim().toLowerCase(), { processingOption: "transitional" })/*url.domainToASCII(req.params.address.trim());*/
    // ok all the comments before this are essentially a lie
    // I ended up going through like 4 libraries that do this, and then finally discovered tr46 (actually i found https://github.com/jcranmer/idna-uts46/ first)
    // This one finally does what I want (can handle emotes that consist of emotes, like 🐈‍⬛ or 🏳️‍⚧️)
    // And it doesn't parse domains into ipv4 addresses, so I was able to remove the check for that
    // I now know far more about the mess that is punycode than I ever wanted to
    // HOURS_WASTED = 3
    let addressAvailability : IAvailabilityResponse = await isAvailable(req.params.address);
    let available = (!addressAvailability.reserved && !addressAvailability.invalid && !addressAvailability.address);
    if (addressAvailability.address === false) return res.reply(new NotFoundReply({ message: "Address not registered", name: req.params.address, available, invalid: addressAvailability.invalid }, true));
    res.reply(new Reply({
        response: {
            message: "Address found",
            name: req.params.address,
            address: addressAvailability.address,
            reserved: addressAvailability.reserved,
            invalid: addressAvailability.invalid,
            available: available
        }
    }));
})

export default router;