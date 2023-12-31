import {blacklist, subdomainRegex} from "../schemas/addressSchema.js";
import ObjectIdToDate from "./ObjectIdToDate.js";
import Database from "../db.js";

export interface  IAvailabilityResponse {
    address: any
    reserved?: boolean
    invalid?: boolean
}

const database = new Database();

/**
 * Check if a name is available
 * @param name
 * @returns {Promise<IAvailabilityResponse>}
 */
export default async function (name : string) : Promise<IAvailabilityResponse> {
    // Check reserved names
    if (blacklist.includes(name)) {
        return {
           address: {
               name,
               registeredAt: new Date(0).toISOString(),
           },
           reserved: true
        }
    }

    // Make sure it is valid
    console.log(name)
    if (!name || !subdomainRegex.test(name)) return {
        address: false,
        invalid: true
    }

    // Find address
    let address = await database.Address.findOne({name})
    // No result means it is not registered
    if (!address) return {
        address: false
    };

    return {
       address: {
           name: address.name,
           registeredAt: ObjectIdToDate(address._id).toISOString(),
       }
    };
}