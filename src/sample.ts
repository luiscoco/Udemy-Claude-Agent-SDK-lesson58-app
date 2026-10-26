import { runAgent, validateConfig } from "./agent.js";
const c = validateConfig({ mode: process.argv[2] || "baseline" });
const e = await runAgent(c, (event) => {
  if (event.type === "text") console.log(event.text);
});
console.log(JSON.stringify(e, null, 2));
process.exitCode = e.workerProcess.exitCode === 0 ? 0 : 1;
