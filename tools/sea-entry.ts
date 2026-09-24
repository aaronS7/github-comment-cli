import { main } from '../src/cli.js';

main().then(code => {
  process.exitCode = code;
}, error => {
  process.stderr.write(`gh-comment: ${error.message}\n`);
  process.exitCode = 1;
});
