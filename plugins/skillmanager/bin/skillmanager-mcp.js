#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const binDirectory = path.dirname(fileURLToPath(import.meta.url))
const entry = path.resolve(binDirectory, '../dist/server/mcp/index.js')

if (!fs.existsSync(entry)) {
  console.error('[SkillManager MCP] Packaged MCP server is missing; reinstall SkillManager.')
  process.exit(1)
}

await import(pathToFileURL(entry).href)
