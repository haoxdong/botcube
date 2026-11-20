import { serveChatService } from '../../src/server.js';

serveChatService(process.env, { filesRoot: process.argv[2] });
