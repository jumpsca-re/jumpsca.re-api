import express from 'express';
import Database from "../../db.js";
import NotFoundReply from "../../classes/Reply/NotFoundReply.js";
import axios from "axios";
import Reply from "../../classes/Reply/Reply.js";

const router = express.Router();

const database = new Database();

router.post('/webhook/:siteId', async (req, res) => {
    let site = await database.Site.findOne({secret: req.query?.key, siteId: req.params.siteId});
    if (!site) return res.reply(new NotFoundReply())
    // noinspection HttpUrlsUsage
    let response = await axios.post(`http://asuna.vps.yggdrasil.cat:5000/deploy/${req.params.siteId}`, JSON.stringify({
        domains: site.deployConfig.domains,
        repoUrl: req.body.repository.ssh_url,
        serveFolder: site.deployConfig.serveFolder,
        branch: site.deployConfig.branch,
        environment: site.deployConfig.environment,
        buildCommand: site.deployConfig.buildCommand,
        headers: site.deployConfig.headers,
        redirects: site.deployConfig.redirects,
        spa: site.deployConfig.spa
    }), {
        headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.DEPLOY_KEY
        }
    })
    console.log(response.data)
    res.sendStatus(200)
});

// v1/site/tls-check
router.get("/tls-check", async (req, res) => {
    let site = await database.Site.findOne({ "deployConfig.domains": req.query.domain })
    if (!site) return res.status(400).json({success: false})
    res.status(200).json({success: true})
})

export default router;