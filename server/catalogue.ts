import type { Book } from "../shared/types";
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
export async function resolveWork(book: Book, signal?: AbortSignal) {
  if (book.status !== "identified" || !book.title)
    return { book, evidence: null };
  const url = new URL("https://openlibrary.org/search.json");
  url.searchParams.set("title", book.title);
  if (book.author) url.searchParams.set("author", book.author);
  url.searchParams.set("limit", "3");
  url.searchParams.set("fields", "key,title,author_name,first_publish_year");
  try {
    const response = await fetch(url, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(7000)])
        : AbortSignal.timeout(7000),
      headers: {
        "User-Agent": "LibraryClaimAgent/0.1 (evidence-driven take-home)",
      },
    });
    if (!response.ok)
      return { book, evidence: { url: url.href, status: response.status } };
    const json = (await response.json()) as any;
    const match = json.docs?.find(
      (doc: any) =>
        norm(doc.title || "") === norm(book.title) &&
        (!book.author ||
          doc.author_name?.some(
            (a: string) =>
              norm(a).includes(norm(book.author)) ||
              norm(book.author).includes(norm(a)),
          )),
    );
    // Work lookup corroborates title only. It cannot establish the edition or ISBN from a spine.
    if (match)
      book.notes = [
        ...book.notes.filter((n) => !n.startsWith("Work catalogue:")),
        `Work catalogue: https://openlibrary.org${match.key}; edition remains supported only by visible evidence.`,
      ];
    else
      book.notes.push(
        "No exact catalogue work match; visible title retained for human review.",
      );
    return {
      book,
      evidence: {
        url: url.href,
        retrieved_at: new Date().toISOString(),
        match: match || null,
      },
    };
  } catch {
    return { book, evidence: null };
  }
}
