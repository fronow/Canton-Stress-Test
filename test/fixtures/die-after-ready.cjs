// Report ready, then exit without reading stdin, so the coordinator's
// start-barrier write hits a closed pipe.
process.stdout.write(JSON.stringify({ ready: true }) + "\n", () => process.exit(0));
