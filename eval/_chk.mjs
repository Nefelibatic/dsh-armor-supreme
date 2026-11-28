import { readFileSync, readdirSync } from "node:fs"
import { armorScore } from "../armor-rules.js"
const dir = "eval/driftprobe"
let bad = 0
for (const f of readdirSync(dir).filter(x => x.endsWith(".md"))) {
  const t = readFileSync(dir + "/" + f, "utf8")
  const s = armorScore(t)
  console.log(`${f.padEnd(26)} ${String(t.length).padStart(5)}ch  ${s.verdict.padEnd(8)} score=${String(s.score).padStart(3)}  ${JSON.stringify(s.words)}`)
  if (s.verdict === "pass") bad++
}
console.log("判为真交付 pass 的份数:", bad)
