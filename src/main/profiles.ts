import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

export interface Profile {
  name: string
  src: string
  template: string
  destinations: string
  // 'folder' (default) or 'file'. Absent on profiles saved before the
  // Folder/File toggle existed — those are treated as folder sources.
  sourceType?: 'folder' | 'file'
  updatedAt: string
}

function profilesPath(): string {
  return join(app.getPath('userData'), 'profiles.json')
}

export async function loadProfiles(): Promise<Profile[]> {
  try {
    const raw = await readFile(profilesPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Profile[]) : []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

async function writeProfiles(profiles: Profile[]): Promise<void> {
  const path = profilesPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(profiles, null, 2), 'utf8')
}

export async function saveProfile(profile: Omit<Profile, 'updatedAt'>): Promise<Profile[]> {
  const profiles = await loadProfiles()
  const now = new Date().toISOString()
  const existing = profiles.findIndex((p) => p.name === profile.name)
  const next: Profile = { ...profile, updatedAt: now }
  if (existing >= 0) profiles[existing] = next
  else profiles.push(next)
  profiles.sort((a, b) => a.name.localeCompare(b.name))
  await writeProfiles(profiles)
  return profiles
}

export async function deleteProfile(name: string): Promise<Profile[]> {
  const profiles = await loadProfiles()
  const filtered = profiles.filter((p) => p.name !== name)
  await writeProfiles(filtered)
  return filtered
}
