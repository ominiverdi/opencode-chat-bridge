import { beforeAll, describe, expect, test } from "bun:test"

class FakeNode {
  childNodes: FakeNode[] = []
  parentNode: FakeNode | null = null
  attributes: Record<string, string> = {}

  constructor(
    readonly nodeType: number,
    readonly tagName: string | null,
    private data = "",
  ) {}

  get firstChild(): FakeNode | null {
    return this.childNodes[0] || null
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.data
    return this.childNodes.map((child) => child.textContent).join("")
  }

  set textContent(_value: string) {
    throw new Error("The renderer must use createTextNode instead of textContent assignment")
  }

  appendChild(child: FakeNode): FakeNode {
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  removeChild(child: FakeNode): FakeNode {
    const index = this.childNodes.indexOf(child)
    if (index < 0) throw new Error("Child not found")
    this.childNodes.splice(index, 1)
    child.parentNode = null
    return child
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value)
  }
}

class FakeDocument {
  createElement(tagName: string): FakeNode {
    return new FakeNode(1, tagName.toUpperCase())
  }

  createTextNode(text: string): FakeNode {
    return new FakeNode(3, null, String(text))
  }
}

interface MessageRenderer {
  render(container: FakeNode, source: string, documentRef: FakeDocument): void
}

let renderer: MessageRenderer
const documentRef = new FakeDocument()

beforeAll(async () => {
  await import("../../connectors/web-message-renderer.js")
  renderer = (globalThis as any).OpenCodeMessageRenderer
})

function render(source: string): FakeNode {
  const container = documentRef.createElement("div")
  renderer.render(container, source, documentRef)
  return container
}

function elements(root: FakeNode, tagName: string): FakeNode[] {
  const target = tagName.toUpperCase()
  const matches: FakeNode[] = []
  function visit(node: FakeNode) {
    if (node.tagName === target) matches.push(node)
    for (const child of node.childNodes) visit(child)
  }
  visit(root)
  return matches
}

function links(root: FakeNode): FakeNode[] {
  return elements(root, "a")
}

describe("safe web message rendering", () => {
  test("linkifies a complete Google Maps URL including its coordinate comma", () => {
    const url = "https://www.google.com/maps?q=41.6281983,2.3807016"
    const root = render(`Location: ${url}`)

    expect(links(root)).toHaveLength(1)
    expect(links(root)[0].textContent).toBe(url)
    expect(links(root)[0].attributes).toEqual({
      href: url,
      target: "_blank",
      rel: "noopener noreferrer",
    })
    expect(root.textContent).toBe(`Location: ${url}`)
  })

  test("linkifies multiple URLs while preserving query strings, fragments, and whitespace", () => {
    const first = "https://example.com/search?q=one,two#results"
    const second = "http://example.org/path?next=%2Fhome"
    const source = `First: ${first}\nSecond:\t${second}`
    const root = render(source)

    expect(links(root).map((link) => link.attributes.href)).toEqual([first, second])
    expect(root.textContent).toBe(source)
  })

  test("excludes trailing sentence punctuation but keeps balanced URL punctuation", () => {
    const root = render([
      "https://example.com/period.",
      "https://example.com/comma,",
      "https://example.com/paren(foo))",
      "https://example.com/bracket]",
    ].join(" "))

    expect(links(root).map((link) => link.attributes.href)).toEqual([
      "https://example.com/period",
      "https://example.com/comma",
      "https://example.com/paren(foo)",
      "https://example.com/bracket",
    ])
    expect(root.textContent).toContain("https://example.com/paren(foo))")
  })

  test("re-renders URLs split across streamed chunks as one final link", () => {
    const root = documentRef.createElement("div")
    let streamed = ""
    streamed += "Map: https://www.google.com/ma"
    renderer.render(root, streamed, documentRef)
    streamed += "ps?q=41.6281983,2.3807016"
    renderer.render(root, streamed, documentRef)

    expect(links(root)).toHaveLength(1)
    expect(links(root)[0].attributes.href).toBe(
      "https://www.google.com/maps?q=41.6281983,2.3807016",
    )
    expect(root.textContent).toBe(streamed)
  })

  test("renders persisted source text with the same clickable links", () => {
    const persisted = "Saved https://example.com/report#summary"
    const initial = render(persisted)
    const afterReload = render(persisted)

    expect(links(afterReload)[0].attributes).toEqual(links(initial)[0].attributes)
    expect(afterReload.textContent).toBe(persisted)
  })

  test("keeps HTML and unsafe schemes as inert text", () => {
    const source = "<img src=https://example.com/x onerror=alert(1)> javascript:alert(1) data:text/html,bad"
    const root = render(source)

    expect(root.textContent).toBe(source)
    expect(elements(root, "img")).toHaveLength(0)
    expect(links(root)).toHaveLength(0)
  })

  test("renders the supported Markdown subset with DOM nodes", () => {
    const root = render([
      "# Title",
      "###### Small heading",
      "",
      "Use **bold**, *italic*, and `code`.",
      "",
      "- alpha",
      "- beta",
      "",
      "1. first",
      "2. second",
      "",
      "```",
      "<unsafe> stays text",
      "```",
    ].join("\n"))

    expect(elements(root, "h1")[0].textContent).toBe("Title")
    expect(elements(root, "h6")[0].textContent).toBe("Small heading")
    expect(elements(root, "strong")[0].textContent).toBe("bold")
    expect(elements(root, "em")[0].textContent).toBe("italic")
    expect(elements(root, "ul")[0].childNodes.map((node) => node.textContent)).toEqual(["alpha", "beta"])
    expect(elements(root, "ol")[0].childNodes.map((node) => node.textContent)).toEqual(["first", "second"])
    expect(elements(root, "pre")[0].textContent).toBe("<unsafe> stays text")
    expect(elements(root, "unsafe")).toHaveLength(0)
  })

  test("renders GFM pipe tables with optional outer pipes and alignment", () => {
    const root = render([
      "Name | Description | Value",
      ":--- | :---: | ---:",
      "Area | Main floor | 25 m²",
      "Cost | Estimate | €500",
    ].join("\n"))

    expect(elements(root, "table")).toHaveLength(1)
    expect(elements(root, "th").map((cell) => cell.textContent)).toEqual([
      "Name", "Description", "Value",
    ])
    expect(elements(root, "th").map((cell) => cell.attributes.style)).toEqual([
      "text-align: left", "text-align: center", "text-align: right",
    ])
    expect(elements(root, "td").map((cell) => cell.textContent)).toEqual([
      "Area", "Main floor", "25 m²", "Cost", "Estimate", "€500",
    ])
  })

  test("supports escaped pipes, code, formatting, and safe links inside table cells", () => {
    const root = render([
      "| Item | Details |",
      "| --- | --- |",
      "| **A** | escaped \\| pipe |",
      "| `x|y` | [site](https://example.com/path?q=1#table) |",
    ].join("\n"))

    expect(elements(root, "tbody")[0].childNodes).toHaveLength(2)
    expect(elements(root, "td").map((cell) => cell.textContent)).toEqual([
      "A", "escaped | pipe", "x|y", "site",
    ])
    expect(elements(root, "strong")[0].textContent).toBe("A")
    expect(elements(root, "code")[0].textContent).toBe("x|y")
    expect(links(root)[0].attributes).toEqual({
      href: "https://example.com/path?q=1#table",
      target: "_blank",
      rel: "noopener noreferrer",
    })
  })

  test("forms a complete table when its rows arrive across streamed chunks", () => {
    const root = documentRef.createElement("div")
    let streamed = "| Name | URL |\n| --- | --- |"
    renderer.render(root, streamed, documentRef)
    streamed += "\n| Map | https://example.com/map?q=1,2 |"
    renderer.render(root, streamed, documentRef)

    expect(elements(root, "tbody")[0].childNodes).toHaveLength(1)
    expect(elements(root, "td").map((cell) => cell.textContent)).toEqual([
      "Map", "https://example.com/map?q=1,2",
    ])
    expect(links(root)[0].attributes.href).toBe("https://example.com/map?q=1,2")
  })

  test("allows only absolute HTTP(S) Markdown links", () => {
    const root = render([
      "[safe](https://example.com/path?q=1#top)",
      "[script](javascript:alert(1))",
      "[data](data:text/html,bad)",
      "[relative](/local/path)",
    ].join(" "))

    expect(links(root)).toHaveLength(1)
    expect(links(root)[0].textContent).toBe("safe")
    expect(links(root)[0].attributes.href).toBe("https://example.com/path?q=1#top")
    expect(root.textContent).toContain("[script](javascript:alert(1))")
    expect(root.textContent).toContain("[relative](/local/path)")
  })
})
