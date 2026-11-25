import { serveChatService } from '../../src/server.js';

await serveChatService(process.env, { filesRoot: process.argv[2] });
