import {
    DOMParser,
    XMLSerializer,
    strFromU8,
    strToU8,
    unzipSync,
    zipSync
} from "./vendor/portable-xlsx.mjs";

const mainNamespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const strictNamespace = "http://purl.oclc.org/ooxml/spreadsheetml/main";
const officeRelations = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const strictRelations = "http://purl.oclc.org/ooxml/officeDocument/relationships";
const packageRelations = "http://schemas.openxmlformats.org/package/2006/relationships";
const maximumFileBytes = 16 * 1024 * 1024;
const maximumExpandedBytes = 32 * 1024 * 1024;
const maximumPartBytes = 8 * 1024 * 1024;
const maximumParts = 512;

function fail(message) {
    throw new Error("ExcelModifyTest: " + message);
}

function elements(parent, namespace, name) {
    return Array.from(parent.getElementsByTagNameNS(namespace, name));
}

function parseXml(text, part) {
    // OOXML 不需要 DTD；禁止实体声明，且遇到任何 XML 诊断立即停止。
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
        fail("不允许 DTD 或实体声明: " + part);
    }
    const document = new DOMParser({
        onError: function (level, message) {
            fail("XML 格式错误 " + part + ": " + level + " " + message);
        }
    }).parseFromString(text, "application/xml");
    if (!document.documentElement) {
        fail("XML 缺少根元素: " + part);
    }
    return document;
}

function readPart(parts, name) {
    if (!Object.hasOwn(parts, name)) {
        fail("工作簿缺少部件: " + name);
    }
    return strFromU8(parts[name]);
}

function resolveWorkbookTarget(target) {
    if (!target || /[\\:#?\u0000]/.test(target)) {
        fail("不安全的工作簿关联路径");
    }
    const segments = target.startsWith("/") ? [] : ["xl"];
    for (const segment of target.split("/")) {
        if (!segment || segment === ".") {
            continue;
        }
        if (segment === "..") {
            if (!segments.length) {
                fail("工作簿关联路径越界");
            }
            segments.pop();
        } else {
            segments.push(segment);
        }
    }
    return segments.join("/");
}

function openParts(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length > maximumFileBytes) {
        fail("输入不是字节数组，或超过 16 MiB 上限");
    }
    let expandedBytes = 0;
    const names = new Set();
    const parts = unzipSync(bytes, {
        filter: function (part) {
            if (names.has(part.name)) {
                fail("ZIP 存在重复部件: " + part.name);
            }
            names.add(part.name);
            expandedBytes += part.originalSize;
            if (names.size > maximumParts || part.originalSize > maximumPartBytes
                || expandedBytes > maximumExpandedBytes) {
                fail("工作簿解压资源超过上限");
            }
            if (/^\/|\\|:|\u0000/.test(part.name)
                || part.name.split("/").some(function (segment) {
                    return segment === ".." || segment === ".";
                })) {
                    fail("不安全的 ZIP 部件名称");
                }
            if (part.name.startsWith("_xmlsignatures/") || /vbaProject\.bin$/i.test(part.name)) {
                fail("不支持带数字签名或 VBA 的工作簿");
            }
            return true;
        }
    });
    // 额外检查实际展开长度，不将归档元数据当作可信输入。
    const actualSize = Object.values(parts).reduce(function (sum, part) {
        if (part.length > maximumPartBytes) {
            fail("工作簿部件超过上限");
        }
        return sum + part.length;
    }, 0);
    if (actualSize > maximumExpandedBytes) {
        fail("工作簿解压资源超过上限");
    }
    return parts;
}

function cellText(cell, strings, namespace) {
    const type = cell.getAttribute("t");
    const values = elements(cell, namespace, "v");
    if (type === "s") {
        const index = values.length ? values[0].textContent : "";
        if (!/^\d+$/.test(index) || Number(index) >= strings.length) {
            fail("共享字符串索引无效: " + cell.getAttribute("r"));
        }
        return strings[Number(index)];
    }
    if (type === "inlineStr") {
        return elements(cell, namespace, "t").map(function (text) {
            return text.textContent;
        }).join("");
    }
    return values.length ? values[0].textContent : "";
}

function coordinate(address) {
    const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(address);
    if (!match) {
        fail("无效的单元格坐标: " + address);
    }
    const column = Array.from(match[1]).reduce(function (value, character) {
        return value * 26 + character.charCodeAt(0) - 64;
    }, 0);
    const row = Number(match[2]);
    if (column > 16384 || row > 1048576) {
        fail("单元格坐标超出 Excel 范围");
    }
    return { column: column, row: row };
}

function nextCell(address) {
    const position = coordinate(address);
    let column = position.column + 1;
    if (column > 16384) {
        fail("字段右侧没有可用单元格");
    }
    let letters = "";
    while (column) {
        column -= 1;
        letters = String.fromCharCode(65 + column % 26) + letters;
        column = Math.floor(column / 26);
    }
    return letters + position.row;
}

function rejectMergedCell(sheet, address, namespace) {
    const position = coordinate(address);
    for (const merge of elements(sheet, namespace, "mergeCell")) {
        const endpoints = merge.getAttribute("ref").split(":");
        const start = coordinate(endpoints[0]);
        const end = coordinate(endpoints[endpoints.length - 1]);
        if (position.row >= start.row && position.row <= end.row
            && position.column >= start.column && position.column <= end.column) {
            fail("目标字段或值属于合并单元格，无法安全修改");
        }
    }
}

function replaceCellSource(source, cell, replacement) {
    // 使用 XML 解析器给出的原始位置，只替换这个节点，避免重写其余单元格。
    const lines = [0];
    const endings = /\r\n|\r|\n/g;
    let ending;
    while ((ending = endings.exec(source)) !== null) {
        lines.push(ending.index + ending[0].length);
    }
    const start = lines[cell.lineNumber - 1] + cell.columnNumber - 1;
    const remainder = source.slice(start);
    const opening = /^<[^\s/>]+(?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?\s*\/?>/.exec(remainder);
    if (!opening || !remainder.startsWith("<" + cell.tagName)
        || !Number.isInteger(start)) {
            fail("无法定位目标单元格的原始 XML");
        }
    let length = opening[0].length;
    if (!opening[0].endsWith("/>")) {
        const closing = "</" + cell.tagName + ">";
        const end = remainder.indexOf(closing, length);
        if (end < 0) {
            fail("目标单元格缺少结束标记");
        }
        length = end + closing.length;
    }
    return source.slice(0, start) + replacement + source.slice(start + length);
}

export function modifyCfgDriverFile(bytes, timestamp) {
    const parts = openParts(bytes);
    const workbook = parseXml(readPart(parts, "xl/workbook.xml"), "xl/workbook.xml");
    const namespace = workbook.documentElement.namespaceURI;
    if (namespace !== mainNamespace && namespace !== strictNamespace) {
        fail("不是支持的 XLSX 工作簿");
    }
    const sheets = elements(workbook, namespace, "sheet").filter(function (sheet) {
        return sheet.getAttribute("name") === "FlashPath";
    });
    if (sheets.length !== 1) {
        fail("必须存在唯一的 FlashPath 工作表");
    }
    const relationId = sheets[0].getAttributeNS(officeRelations, "id")
        || sheets[0].getAttributeNS(strictRelations, "id");
    const relationships = parseXml(readPart(parts, "xl/_rels/workbook.xml.rels"), "工作簿关系");
    const relations = elements(relationships, packageRelations, "Relationship");
    const matches = relations.filter(function (relation) {
        return relation.getAttribute("Id") === relationId;
    });
    if (matches.length !== 1 || matches[0].getAttribute("TargetMode") === "External"
        || !matches[0].getAttribute("Type").endsWith("/worksheet")) {
        fail("FlashPath 工作表关联无效");
    }
    const modifiedPart = resolveWorkbookTarget(matches[0].getAttribute("Target"));
    const source = readPart(parts, modifiedPart);
    const sheet = parseXml(source, modifiedPart);
    const sharedRelations = relations.filter(function (relation) {
        return relation.getAttribute("Type").endsWith("/sharedStrings");
    });
    const sharedPart = sharedRelations.length
        ? resolveWorkbookTarget(sharedRelations[0].getAttribute("Target"))
        : "xl/sharedStrings.xml";
    const strings = Object.hasOwn(parts, sharedPart)
        ? elements(parseXml(readPart(parts, sharedPart), sharedPart), namespace, "si").map(function (item) {
            return elements(item, namespace, "t").map(function (text) {
                return text.textContent;
            }).join("");
        }) : [];
    const cells = elements(sheet, namespace, "c");
    const keys = cells.filter(function (cell) {
        return cellText(cell, strings, namespace) === "CfgDriverFile";
    });
    if (keys.length !== 1) {
        fail("FlashPath 中必须存在唯一的 CfgDriverFile 字段");
    }
    const keyCell = keys[0].getAttribute("r");
    const valueCell = nextCell(keyCell);
    const targets = cells.filter(function (cell) {
        return cell.getAttribute("r") === valueCell;
    });
    if (targets.length !== 1) {
        fail("CfgDriverFile 右侧必须存在唯一的值单元格");
    }
    rejectMergedCell(sheet, keyCell, namespace);
    rejectMergedCell(sheet, valueCell, namespace);
    const cell = targets[0];
    const previousValue = cellText(cell, strings, namespace);
    const changed = cell.cloneNode(true);
    changed.setAttribute("t", "inlineStr");
    for (const child of Array.from(changed.childNodes)) {
        if (child.nodeType === 1 && child.namespaceURI === namespace
            && ["v", "f", "is"].includes(child.localName)) {
                changed.removeChild(child);
            }
    }
    const prefix = cell.prefix ? cell.prefix + ":" : "";
    const inline = sheet.createElementNS(namespace, prefix + "is");
    const text = sheet.createElementNS(namespace, prefix + "t");
    text.appendChild(sheet.createTextNode(timestamp));
    inline.appendChild(text);
    changed.insertBefore(inline, changed.firstChild);
    const replacement = new XMLSerializer().serializeToString(changed);
    const modifiedSource = replaceCellSource(source, cell, replacement);
    parseXml(modifiedSource, modifiedPart);
    parts[modifiedPart] = strToU8(modifiedSource);
    // 重新封装 ZIP，但其它部件的展开字节完全复用，外部链接不会丢失或访问。
    const output = zipSync(parts, { level: 6 });
    if (output.length > maximumFileBytes) {
        fail("输出超过 16 MiB 上限");
    }
    return {
        bytes: output,
        report: {
            sheet: "FlashPath",
            key: "CfgDriverFile",
            keyCell: keyCell,
            valueCell: valueCell,
            previousValue: previousValue,
            currentValue: timestamp,
            timestamp: timestamp,
            modifiedPart: modifiedPart,
            preservedPartCount: Object.keys(parts).length - 1
        }
    };
}
