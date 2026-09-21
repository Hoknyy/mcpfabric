#!/usr/bin/env node
import { main } from './cli.mjs';
main().then(code => { process.exitCode = code; }).catch(error => { console.error('runner error: ' + error.message); process.exitCode = 2; });
