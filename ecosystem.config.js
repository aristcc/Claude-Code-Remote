module.exports = {
  apps: [
    {
      name: 'ngrok-telegram',
      script: 'ngrok',
      args: 'http 3001 --log=stdout',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000
    },
    {
      name: 'telegram-webhook',
      script: 'start-telegram-webhook.js',
      cwd: __dirname,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      // Wait for ngrok to start first
      wait_ready: false
    }
  ]
};
