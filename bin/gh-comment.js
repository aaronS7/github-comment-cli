#!/usr/bin/env node
import { main } from '../build/src/cli.js';

process.exitCode = await main();
