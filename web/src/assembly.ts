import DOMPurify from "dompurify";

export function simplifyAssembly(asm: string): string {
  const out: string[] = [];
  let previousBlank = false;
  let skippingSection = false;

  for (const rawLine of asm.replaceAll("\r\n", "\n").split("\n")) {
    const trimmed = rawLine.trim();

    if (!trimmed) {
      if (!previousBlank && out.length > 0) out.push("");
      previousBlank = true;
      continue;
    }

    if (trimmed.startsWith(".section")) {
      skippingSection = !trimmed.includes(".text");
      continue;
    }
    if (trimmed === ".text") {
      skippingSection = false;
      continue;
    }
    if (skippingSection) continue;
    if (isNoisyAsmLine(trimmed)) continue;

    const line = normalizeAsmLine(rawLine);
    if (!line) continue;
    out.push(line);
    previousBlank = false;
  }

  return out.join("\n").trimEnd();
}

export function highlightAssembly(text: string): string {
  const html = text
    .split("\n")
    .map((line) => {
      const commentIndex = line.indexOf("#");
      const code = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
      const comment = commentIndex >= 0 ? line.slice(commentIndex) : "";
      return `${highlightAsmCode(code)}${comment ? `<span class="asm-comment">${escapeHtml(comment)}</span>` : ""}`;
    })
    .join("\n");
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["span"],
    ALLOWED_ATTR: ["class"]
  });
}

function isNoisyAsmLine(trimmed: string): boolean {
  if (/^@feat\.00\b/.test(trimmed)) return true;
  if (/^\.(Ltmp|Lfunc_end|Linfo_string|Lstr|Lsec_end|Ldebug|Lline|Lcu)/.test(trimmed)) return true;
  if (/^\s*#\s*(kill|fake_use):/.test(trimmed)) return true;
  if (/^#\s*(?:--\s*(?:Begin|End) function|%bb\.)/.test(trimmed)) return true;
  return /^(?:\.(?:def|scl|type|size|endef|file|globl|global|p2align|align|addrsig|ident|seh_|cfi_|cv_|loc|long|short|byte|quad|set)\b)/.test(
    trimmed
  );
}

function normalizeAsmLine(line: string): string {
  const trimmed = line.trim();
  const label = /^([.$A-Za-z_][\w.$@]*:)(?:\s*(.*))?$/.exec(trimmed);
  if (label) {
    const name = label[1];
    if (/^\.(?:Ltmp|Lfunc_end|Ldebug)/.test(name)) return "";
    return label[2] ? `${name.padEnd(24)} ${label[2].trim()}` : name;
  }
  if (trimmed.startsWith("#")) return trimmed;
  return `    ${trimmed.replace(/\s+/g, " ")}`;
}

function highlightAsmCode(code: string): string {
  let escaped = escapeHtml(code);
  escaped = escaped.replace(/^(\s*[.$A-Za-z_][\w.$@]*:)/, '<span class="asm-label">$1</span>');
  escaped = escaped.replace(/^(\s*)([a-z][a-z0-9.]*)(\b)/, '$1<span class="asm-op">$2</span>$3');
  escaped = escaped.replace(
    /(%?)(\b(?:r(?:ax|bx|cx|dx|si|di|bp|sp|ip|[8-9]|1[0-5])(?:[bwd])?|e(?:ax|bx|cx|dx|si|di|bp|sp)|[abcd][lh]|[er]?(?:flags)|xmm\d+|ymm\d+|zmm\d+)\b)/gi,
    '<span class="asm-reg">$1$2</span>'
  );
  escaped = escaped.replace(/(\$?-?\b(?:0x[0-9a-f]+|\d+)\b)/gi, '<span class="asm-imm">$1</span>');
  return escaped;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
