package game

import (
	_ "embed"
	"strings"
)

// Built-in prompt pools — the words a player is asked to draw when the host
// doesn't supply custom categories. Stored as plain one-word-per-line text files
// (words_en.txt / words_ar.txt) and embedded into the binary at build time, so
// the lists can be edited, sorted, or de-duped with ordinary tools without
// touching Go. Only the *prompt words* are localized (English or Arabic) — the
// rest of the game UI stays English. Blank lines and lines starting with '#'
// (comments) are ignored, so the files can be grouped/annotated freely.

//go:embed words_en.txt
var rawWordsEN string

//go:embed words_ar.txt
var rawWordsAR string

var (
	builtinCategoriesEN = parseWordList(rawWordsEN)
	builtinCategoriesAR = parseWordList(rawWordsAR)
)

// parseWordList splits an embedded word file into a trimmed, comment-free slice.
func parseWordList(s string) []string {
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		out = append(out, l)
	}
	return out
}

// builtinPool returns the default prompt pool for a language. Unknown languages
// fall back to English so the game is always playable.
func builtinPool(lang Language) []string {
	if lang == LangAR {
		return builtinCategoriesAR
	}
	return builtinCategoriesEN
}
