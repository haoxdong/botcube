import path from 'node:path';

// A build config whose dcv alias points into the app's own node_modules, where a clone's container installs it (#4054).
export default ({ appRoot }) => ({
  turbopackAliases: { dcv: path.join(appRoot, 'node_modules/bedrock-agentcore/dcv.js') },
});
