#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cubeApp, deployRoot } from '../cube.mjs';

process.env.CARTRIDGE_DEPLOY_ROOT = deployRoot;
await import(pathToFileURL(resolve(cubeApp, 'dist/bin/cdk.js')).href);
