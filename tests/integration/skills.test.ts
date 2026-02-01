/**
 * Integration tests for skills.ts
 */

import { describe, test, expect } from "bun:test"
import { loadSkills, getSkill, listSkills } from "../../src/skills"

describe("skills", () => {
  describe("loadSkills", () => {
    test("loads skills from skills directory", async () => {
      const skills = await loadSkills()
      
      expect(skills.size).toBeGreaterThan(0)
    })

    test("returns Map of skills", async () => {
      const skills = await loadSkills()
      
      expect(skills).toBeInstanceOf(Map)
    })

    test("skill objects have required properties", async () => {
      const skills = await loadSkills()
      
      for (const [name, skill] of skills) {
        expect(skill.name).toBe(name)
        expect(typeof skill.description).toBe("string")
        expect(typeof skill.prompt).toBe("string")
        expect(typeof skill.file).toBe("string")
        expect(skill.prompt.length).toBeGreaterThan(0)
      }
    })

    test("loads plain.md skill", async () => {
      const skills = await loadSkills()
      
      const plain = skills.get("plain")
      expect(plain).toBeDefined()
      expect(plain?.name).toBe("plain")
    })
  })

  describe("getSkill", () => {
    test("returns skill by name", async () => {
      const skill = await getSkill("plain")
      
      expect(skill).not.toBeNull()
      expect(skill?.name).toBe("plain")
    })

    test("returns null for non-existent skill", async () => {
      const skill = await getSkill("nonexistent-skill-xyz")
      
      expect(skill).toBeNull()
    })
  })

  describe("listSkills", () => {
    test("returns array of skills", async () => {
      const skills = await listSkills()
      
      expect(Array.isArray(skills)).toBe(true)
      expect(skills.length).toBeGreaterThan(0)
    })

    test("each skill in list has required properties", async () => {
      const skills = await listSkills()
      
      for (const skill of skills) {
        expect(skill.name).toBeDefined()
        expect(skill.description).toBeDefined()
        expect(skill.prompt).toBeDefined()
        expect(skill.file).toBeDefined()
      }
    })
  })

  describe("skill parsing", () => {
    test("parses frontmatter description", async () => {
      // Test with a skill that has frontmatter
      const skills = await loadSkills()
      
      // At least one skill should have a non-empty description
      const hasDescription = Array.from(skills.values()).some(
        skill => skill.description.length > 0
      )
      expect(hasDescription).toBe(true)
    })

    test("extracts prompt content after frontmatter", async () => {
      const skill = await getSkill("plain")
      
      expect(skill?.prompt).toBeDefined()
      // Prompt should not contain the frontmatter delimiters in the main content
      expect(skill?.prompt.startsWith("---")).toBe(false)
    })

    test("handles skills without frontmatter", async () => {
      // All skills should load even if some don't have frontmatter
      const skills = await loadSkills()
      
      for (const skill of skills.values()) {
        expect(skill.prompt.length).toBeGreaterThan(0)
      }
    })
  })
})
