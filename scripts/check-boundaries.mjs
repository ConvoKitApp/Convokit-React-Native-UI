import { readFile, readdir } from 'node:fs/promises'

for (const name of await readdir(new URL('../src/', import.meta.url))) {
  if (!/\.tsx?$/.test(name)) continue
  const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8')
  if (/from ['"]expo(?:-|\/|['"])/.test(source)) throw new Error(`${name} imports Expo`)
  if (/from ['"](?:react-native-config|@react-native-documents\/picker)/.test(source)) {
    throw new Error(`${name} imports an app-only native dependency`)
  }
}
