/**
 * Safe, dependency-free renderer for assistant messages.
 * Supports a small Markdown subset and plain HTTP(S) URL linkification.
 */
;(function (global) {
  "use strict"

  var URL_START = /^https?:\/\//i
  var URL_BODY = /^https?:\/\/[^\s<>"']+/i
  var SIMPLE_TRAILING_PUNCTUATION = /[.,!?;:]$/
  var CLOSING_PAIRS = { ")": "(", "]": "[", "}": "{" }

  function isHttpUrl(value) {
    if (!URL_START.test(value) || /\s/.test(value)) return false
    try {
      var parsed = new URL(value)
      return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname)
    } catch (error) {
      return false
    }
  }

  function countCharacter(value, character) {
    var count = 0
    for (var i = 0; i < value.length; i++) {
      if (value.charAt(i) === character) count++
    }
    return count
  }

  function trimTrailingPunctuation(candidate) {
    var value = candidate
    var suffix = ""
    var changed = true

    while (value && changed) {
      changed = false
      var last = value.charAt(value.length - 1)
      if (SIMPLE_TRAILING_PUNCTUATION.test(last)) {
        suffix = last + suffix
        value = value.slice(0, -1)
        changed = true
        continue
      }

      var opener = CLOSING_PAIRS[last]
      if (opener && countCharacter(value, last) > countCharacter(value, opener)) {
        suffix = last + suffix
        value = value.slice(0, -1)
        changed = true
      }
    }

    return { url: value, suffix: suffix }
  }

  function plainUrlAt(text, index) {
    if (index > 0 && /[A-Za-z0-9_@]/.test(text.charAt(index - 1))) return null
    var match = text.slice(index).match(URL_BODY)
    if (!match) return null

    var trimmed = trimTrailingPunctuation(match[0])
    if (!trimmed.url || !isHttpUrl(trimmed.url)) return null
    return {
      url: trimmed.url,
      suffix: trimmed.suffix,
      length: match[0].length,
    }
  }

  function markdownLinkAt(text, index) {
    if (text.charAt(index) !== "[" || (index > 0 && text.charAt(index - 1) === "!")) return null
    var labelEnd = text.indexOf("](", index + 1)
    if (labelEnd < 0) return null

    var depth = 1
    var urlStart = labelEnd + 2
    var cursor = urlStart
    for (; cursor < text.length; cursor++) {
      var character = text.charAt(cursor)
      if (character === "(") depth++
      if (character === ")") {
        depth--
        if (depth === 0) break
      }
    }
    if (depth !== 0) return null

    var url = text.slice(urlStart, cursor)
    if (!isHttpUrl(url)) return null
    return {
      label: text.slice(index + 1, labelEnd),
      url: url,
      length: cursor - index + 1,
    }
  }

  function appendLink(parent, label, url, documentRef) {
    var link = documentRef.createElement("a")
    link.setAttribute("href", url)
    link.setAttribute("target", "_blank")
    link.setAttribute("rel", "noopener noreferrer")
    link.appendChild(documentRef.createTextNode(label))
    parent.appendChild(link)
  }

  function appendInline(parent, text, documentRef) {
    var plain = ""

    function flushPlain() {
      if (!plain) return
      parent.appendChild(documentRef.createTextNode(plain))
      plain = ""
    }

    for (var index = 0; index < text.length;) {
      if (text.charAt(index) === "<") {
        var tagEnd = text.indexOf(">", index + 1)
        if (tagEnd < 0) tagEnd = text.length - 1
        plain += text.slice(index, tagEnd + 1)
        index = tagEnd + 1
        continue
      }

      if (text.charAt(index) === "`") {
        var codeEnd = text.indexOf("`", index + 1)
        if (codeEnd > index + 1) {
          flushPlain()
          var code = documentRef.createElement("code")
          code.appendChild(documentRef.createTextNode(text.slice(index + 1, codeEnd)))
          parent.appendChild(code)
          index = codeEnd + 1
          continue
        }
      }

      var markdownLink = markdownLinkAt(text, index)
      if (markdownLink) {
        flushPlain()
        var link = documentRef.createElement("a")
        link.setAttribute("href", markdownLink.url)
        link.setAttribute("target", "_blank")
        link.setAttribute("rel", "noopener noreferrer")
        appendInline(link, markdownLink.label, documentRef)
        parent.appendChild(link)
        index += markdownLink.length
        continue
      }

      var marker = text.slice(index, index + 2)
      if (marker === "**" || marker === "__") {
        var strongEnd = text.indexOf(marker, index + 2)
        if (strongEnd > index + 2) {
          flushPlain()
          var strong = documentRef.createElement("strong")
          appendInline(strong, text.slice(index + 2, strongEnd), documentRef)
          parent.appendChild(strong)
          index = strongEnd + 2
          continue
        }
      }

      var emphasisMarker = text.charAt(index)
      if (emphasisMarker === "*" || emphasisMarker === "_") {
        var emphasisEnd = text.indexOf(emphasisMarker, index + 1)
        if (emphasisEnd > index + 1) {
          flushPlain()
          var emphasis = documentRef.createElement("em")
          appendInline(emphasis, text.slice(index + 1, emphasisEnd), documentRef)
          parent.appendChild(emphasis)
          index = emphasisEnd + 1
          continue
        }
      }

      var plainUrl = plainUrlAt(text, index)
      if (plainUrl) {
        flushPlain()
        appendLink(parent, plainUrl.url, plainUrl.url, documentRef)
        if (plainUrl.suffix) parent.appendChild(documentRef.createTextNode(plainUrl.suffix))
        index += plainUrl.length
        continue
      }

      plain += text.charAt(index)
      index++
    }

    flushPlain()
  }

  function appendParagraph(parent, lines, documentRef) {
    var paragraph = documentRef.createElement("p")
    for (var i = 0; i < lines.length; i++) {
      if (i > 0) paragraph.appendChild(documentRef.createTextNode("\n"))
      appendInline(paragraph, lines[i], documentRef)
    }
    parent.appendChild(paragraph)
  }

  function isEscaped(value, index) {
    var backslashes = 0
    for (var cursor = index - 1; cursor >= 0 && value.charAt(cursor) === "\\"; cursor--) {
      backslashes++
    }
    return backslashes % 2 === 1
  }

  function splitTableRow(line) {
    var value = line.trim()
    var hasSeparator = false
    var inCode = false
    for (var probe = 0; probe < value.length; probe++) {
      var probeCharacter = value.charAt(probe)
      if (probeCharacter === "`" && !isEscaped(value, probe)) inCode = !inCode
      if (probeCharacter === "|" && !inCode && !isEscaped(value, probe)) {
        hasSeparator = true
        break
      }
    }
    if (!hasSeparator) return null

    if (value.charAt(0) === "|") value = value.slice(1)
    if (value.charAt(value.length - 1) === "|" && !isEscaped(value, value.length - 1)) {
      value = value.slice(0, -1)
    }

    var cells = []
    var cell = ""
    inCode = false
    for (var index = 0; index < value.length; index++) {
      var character = value.charAt(index)
      if (character === "`" && !isEscaped(value, index)) {
        inCode = !inCode
        cell += character
        continue
      }
      if (character === "|" && !inCode && !isEscaped(value, index)) {
        cells.push(cell.trim())
        cell = ""
        continue
      }
      if (character === "|" && isEscaped(value, index) && cell.charAt(cell.length - 1) === "\\") {
        cell = cell.slice(0, -1)
      }
      cell += character
    }
    cells.push(cell.trim())
    return cells
  }

  function tableDelimiter(cells) {
    if (!cells || cells.length === 0) return null
    var alignments = []
    for (var index = 0; index < cells.length; index++) {
      var value = cells[index].replace(/\s+/g, "")
      if (!/^:?-{3,}:?$/.test(value)) return null
      alignments.push(
        value.charAt(0) === ":" && value.charAt(value.length - 1) === ":" ? "center" :
          value.charAt(value.length - 1) === ":" ? "right" :
            value.charAt(0) === ":" ? "left" : null,
      )
    }
    return alignments
  }

  function appendTableCell(row, tagName, content, alignment, documentRef) {
    var cell = documentRef.createElement(tagName)
    if (alignment) cell.setAttribute("style", "text-align: " + alignment)
    appendInline(cell, content, documentRef)
    row.appendChild(cell)
  }

  function appendTable(parent, lines, startIndex, documentRef) {
    if (startIndex + 1 >= lines.length) return 0
    var headers = splitTableRow(lines[startIndex])
    var delimiters = splitTableRow(lines[startIndex + 1])
    var alignments = tableDelimiter(delimiters)
    if (!headers || !alignments || headers.length !== alignments.length) return 0

    var table = documentRef.createElement("table")
    var tableHead = documentRef.createElement("thead")
    var headerRow = documentRef.createElement("tr")
    for (var column = 0; column < headers.length; column++) {
      appendTableCell(headerRow, "th", headers[column], alignments[column], documentRef)
    }
    tableHead.appendChild(headerRow)
    table.appendChild(tableHead)

    var tableBody = documentRef.createElement("tbody")
    var index = startIndex + 2
    for (; index < lines.length; index++) {
      if (!lines[index].trim()) break
      var values = splitTableRow(lines[index])
      if (!values) break
      var bodyRow = documentRef.createElement("tr")
      for (column = 0; column < headers.length; column++) {
        appendTableCell(bodyRow, "td", values[column] || "", alignments[column], documentRef)
      }
      tableBody.appendChild(bodyRow)
    }
    table.appendChild(tableBody)
    parent.appendChild(table)
    return index - startIndex
  }

  function renderMessage(container, source, documentRef) {
    var doc = documentRef || container.ownerDocument || global.document
    while (container.firstChild) container.removeChild(container.firstChild)

    var text = String(source == null ? "" : source).replace(/\r\n?/g, "\n")
    var lines = text.split("\n")
    var paragraphLines = []

    function flushParagraph() {
      if (paragraphLines.length === 0) return
      appendParagraph(container, paragraphLines, doc)
      paragraphLines = []
    }

    for (var index = 0; index < lines.length;) {
      var line = lines[index]

      if (/^\s*```/.test(line)) {
        flushParagraph()
        var codeLines = []
        index++
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
          codeLines.push(lines[index])
          index++
        }
        if (index < lines.length) index++
        var pre = doc.createElement("pre")
        var code = doc.createElement("code")
        code.appendChild(doc.createTextNode(codeLines.join("\n")))
        pre.appendChild(code)
        container.appendChild(pre)
        continue
      }

      var possibleHeaders = splitTableRow(line)
      var possibleAlignments = index + 1 < lines.length
        ? tableDelimiter(splitTableRow(lines[index + 1]))
        : null
      if (possibleHeaders && possibleAlignments && possibleHeaders.length === possibleAlignments.length) {
        flushParagraph()
        var tableLines = appendTable(container, lines, index, doc)
        index += tableLines
        continue
      }

      var heading = line.match(/^ {0,3}(#{1,6})[ \t]+(.*)$/)
      if (heading) {
        flushParagraph()
        var headingElement = doc.createElement("h" + heading[1].length)
        appendInline(headingElement, heading[2], doc)
        container.appendChild(headingElement)
        index++
        continue
      }

      var unordered = line.match(/^\s*[-+*][ \t]+(.*)$/)
      var ordered = line.match(/^\s*\d+[.)][ \t]+(.*)$/)
      if (unordered || ordered) {
        flushParagraph()
        var orderedList = Boolean(ordered)
        var list = doc.createElement(orderedList ? "ol" : "ul")
        while (index < lines.length) {
          var item = lines[index].match(orderedList
            ? /^\s*\d+[.)][ \t]+(.*)$/
            : /^\s*[-+*][ \t]+(.*)$/)
          if (!item) break
          var listItem = doc.createElement("li")
          appendInline(listItem, item[1], doc)
          list.appendChild(listItem)
          index++
        }
        container.appendChild(list)
        continue
      }

      if (line === "") {
        flushParagraph()
        index++
        continue
      }

      paragraphLines.push(line)
      index++
    }

    flushParagraph()
  }

  global.OpenCodeMessageRenderer = {
    render: renderMessage,
  }
})(typeof window !== "undefined" ? window : globalThis)
