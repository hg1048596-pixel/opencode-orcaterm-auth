import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

export function prepareGithubPackage(directory, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) throw new Error("Invalid package version")
  const manifestPath = path.join(directory, "package.json")
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  if (manifest.name !== "opencode-orcaterm-auth" || manifest.version !== version) {
    throw new Error("The downloaded npm package does not match the requested name and version")
  }
  for (const entry of ["index.mjs", "wechat.mjs"]) {
    if (!fs.statSync(path.join(directory, entry)).isFile()) throw new Error(`Missing package entry: ${entry}`)
  }
  manifest.name = "@hg1048596-pixel/opencode-orcaterm-auth"
  manifest.repository = { type: "git", url: "git+https://github.com/hg1048596-pixel/opencode-orcaterm-auth.git" }
  manifest.publishConfig = { ...manifest.publishConfig, registry: "https://npm.pkg.github.com" }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8")
  return { name: manifest.name, version: manifest.version }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(prepareGithubPackage(process.argv[2], process.argv[3])))
}
