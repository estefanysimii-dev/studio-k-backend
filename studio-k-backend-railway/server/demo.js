process.env.STUDIO_DEMO='true';
process.env.HOST='127.0.0.1';
process.env.PORT=process.env.PORT||'3210';
process.env.PUBLIC_URL=`http://localhost:${process.env.PORT}`;
process.env.DATA_DIR='./demo-data';
delete process.env.DISCORD_TOKEN;
delete process.env.INTEGRATION_KEY;
await import('./index.js');
