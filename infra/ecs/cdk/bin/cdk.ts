#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cartridgeDeployRoot } from '../lib/cartridge.js';
import { CARTRIDGE_ECS_APP, productionApp } from '../lib/production-app.js';

// A Cartridge with an ECS app of its own deploys through it; without its resources this app would delete them.
const own = path.join(cartridgeDeployRoot(), CARTRIDGE_ECS_APP);
if (fs.existsSync(path.join(own, 'package.json'))) {
  throw new Error(`This Cartridge deploys its ECS stacks through its own app, ${own}: run that app, or bin/launch.mjs`);
}
export const app = productionApp();
