// PM2 process config for the Dexvra bot. Run from the bot/ directory:
//   pm2 start ecosystem.config.js && pm2 save
// Reads secrets from bot/.env (loaded by main.js via dotenv) — do NOT put
// secrets here.
module.exports = {
  apps: [
    {
      name: "dexvra-bot",
      script: "main.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      watch: false,
      max_memory_restart: "400M",
      env: { NODE_ENV: "production" },
    },
    {
      name: "dexvra-adminbot",
      script: "adminbot.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      watch: false,
      max_memory_restart: "250M",
      env: { NODE_ENV: "production" },
    },
  ],
};
