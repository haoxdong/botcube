import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const settings = process.env.BOTCUBE_TEST_IMAGE_SETTINGS;
if (!settings) throw new Error('The test process needs its Bot Image settings fixture');
const read = fs.readFileSync;
const exists = fs.existsSync;
fs.readFileSync = (path, ...options) => read(path === '/bot/bot.yaml' ? settings : path, ...options);
fs.existsSync = path => exists(path === '/bot/bot.yaml' ? settings : path);
syncBuiltinESMExports();
