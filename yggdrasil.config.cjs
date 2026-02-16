module.exports = {
	apps : [{
		name: `jumpsca.re-phoenix`,
		script: 'npm run start',
		env_phoenix: {
			JR_ENV: "phoenix",
			NODE_ENV: "production"
		}
	},{
		name: `jumpsca.re-production`,
		script: 'npm run start',
		env_production: {
			JR_ENV: "production",
			NODE_ENV: "production"
		}
	}],
	// Deployment Configuration
	deploy : {
		phoenix : {
			"user" : "jumpscare",
			"host" : ["10.5.2.2"],
			"ref"  : "origin/phoenix",
			"repo" : "git@github.com:LITdevs/jumpsca.re-api.git",
			"path" : "/home/jumpscare/phoenix",
			"post-deploy" : "yarn install && pm2 startOrRestart yggdrasil.config.cjs --only jumpsca.re-phoenix --env phoenix"
		},
		production : {
			"user" : "jumpscare",
			"host" : ["10.5.2.2"],
			"ref"  : "origin/prod",
			"repo" : "git@github.com:LITdevs/jumpsca.re-api.git",
			"path" : "/home/jumpscare/production",
			"post-deploy" : "yarn install && pm2 startOrRestart yggdrasil.config.cjs --only jumpsca.re-production --env production"
		}
	}
};