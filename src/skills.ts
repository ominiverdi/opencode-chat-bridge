/**
 * Skills Loader - Loads custom prompts/skills from the skills/ directory
 */

import { readdir, readFile } from "fs/promises"
import { join } from "path"

export interface Skill {
  name: string
  description: string
  prompt: string
  file: string
}

const SKILLS_DIR = join(import.meta.dir, "..", "skills")

export async function loadSkills(): Promise<Map<string, Skill>> {
  const skills = new Map<string, Skill>()
  
  try {
    const files = await readdir(SKILLS_DIR)
    
    for (const file of files) {
      if (!file.endsWith(".md") && !file.endsWith(".txt")) continue
      
      const filePath = join(SKILLS_DIR, file)
      const content = await readFile(filePath, "utf-8")
      
      // Parse skill metadata from frontmatter or first lines
      const skill = parseSkill(file, content)
      if (skill) {
        skills.set(skill.name, skill)
      }
    }
  } catch (err) {
    // Skills directory may not exist yet
  }
  
  return skills
}

function parseSkill(file: string, content: string): Skill | null {
  const name = file.replace(/\.(md|txt)$/, "")
  let description = ""
  let prompt = content
  
  // Check for YAML frontmatter
  if (content.startsWith("---")) {
    const endIndex = content.indexOf("---", 3)
    if (endIndex > 0) {
      const frontmatter = content.slice(3, endIndex).trim()
      prompt = content.slice(endIndex + 3).trim()
      
      // Parse simple YAML
      const lines = frontmatter.split("\n")
      for (const line of lines) {
        const [key, ...valueParts] = line.split(":")
        const value = valueParts.join(":").trim()
        if (key.trim() === "description") {
          description = value
        }
      }
    }
  }
  
  // Use first line as description if not set
  if (!description) {
    const firstLine = prompt.split("\n")[0]
    if (firstLine.startsWith("#")) {
      description = firstLine.replace(/^#+\s*/, "")
    }
  }
  
  return {
    name,
    description,
    prompt,
    file,
  }
}

export async function getSkill(name: string): Promise<Skill | null> {
  const skills = await loadSkills()
  return skills.get(name) || null
}

export async function listSkills(): Promise<Skill[]> {
  const skills = await loadSkills()
  return Array.from(skills.values())
}
