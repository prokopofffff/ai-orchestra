import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown renderer for chat messages. TL replies use headings, bold,
 * bullet lists, numbered lists, and (with remark-gfm) tables — without
 * a renderer they show up as raw `## ...` and `| col | col |` lines.
 *
 * Component overrides apply Tailwind classes inline so the output uses
 * the same design tokens as the rest of the chat (text-sm, text-text-*,
 * spacing) instead of fighting browser defaults.
 *
 * Code blocks: short illustrative snippets are common in TL replies
 * (single function signature, config field). The dispatcher's mid-stream
 * guard already aborts on blocks > 10 lines so anything that reaches
 * here is intentionally small; render in a tight monospace box.
 */
const components: Components = {
  h1: ({ children }) => <h1 className="text-base font-semibold mt-3 mb-1.5 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="text-[15px] font-semibold mt-3 mb-1.5 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="text-[14px] font-semibold mt-2.5 mb-1 first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="text-[13px] font-semibold mt-2 mb-1 first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="my-1.5 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 ml-4 list-disc space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 ml-4 list-decimal space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  hr: () => <hr className="my-2.5 border-border-subtle" />,
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-border pl-3 text-text-secondary italic">{children}</blockquote>
  ),
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent-blue underline hover:no-underline">
      {children}
    </a>
  ),
  // Inline code vs fenced block: react-markdown passes inline= via the
  // `node` parent. The simpler heuristic: if children is a single short
  // string with no newline, treat as inline.
  code: ({ children, className }) => {
    const text = String(children ?? "");
    const isInline = !text.includes("\n");
    if (isInline) {
      return (
        <code className="bg-bg-input border border-border-subtle px-1 py-0.5 rounded text-[0.85em] font-mono">
          {children}
        </code>
      );
    }
    return (
      <code className={`block ${className ?? ""} font-mono text-[12.5px]`}>{children}</code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-1.5 bg-bg-input border border-border-subtle rounded px-3 py-2 overflow-x-auto">{children}</pre>
  ),
  // GitHub-flavored markdown tables — these come up a lot in TL plan
  // summaries ("here are the tasks I'll create | task | role | …").
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse text-[12.5px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-border">{children}</thead>,
  th: ({ children }) => <th className="px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="px-2 py-1 border-t border-border-subtle align-top">{children}</td>,
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
