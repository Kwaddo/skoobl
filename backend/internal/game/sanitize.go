package game

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// hexColor matches #rgb, #rrggbb, and #rrggbbaa. Stroke colors that don't match
// are replaced with a safe default so nothing arbitrary reaches the DOM.
var hexColor = regexp.MustCompile(`^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$`)

const defaultStrokeColor = "#f5f4ec"

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func clampF(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// sanitizeCategories trims, de-dupes, length-caps, and count-caps host-supplied
// prompt words. Rendering is React-escaped, so this is about bounding size and
// keeping the pool sane rather than XSS.
func sanitizeCategories(in []string) []string {
	out := make([]string, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, c := range in {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		if utf8.RuneCountInString(c) > maxCategoryLen {
			c = string([]rune(c)[:maxCategoryLen])
		}
		if seen[c] {
			continue
		}
		seen[c] = true
		out = append(out, c)
		if len(out) >= maxCustomCategories {
			break
		}
	}
	return out
}

// sanitizeStrokes bounds an incoming drawing: caps strokes, points-per-stroke,
// and total points; clamps widths and coordinates; and validates colors.
func sanitizeStrokes(in []Stroke) []Stroke {
	if len(in) > maxStrokes {
		in = in[:maxStrokes]
	}
	out := make([]Stroke, 0, len(in))
	total := 0
	for _, s := range in {
		pts := s.Points
		if len(pts) == 0 {
			continue
		}
		if len(pts) > maxPointsPerStroke {
			pts = pts[:maxPointsPerStroke]
		}
		clean := make([]Point, 0, len(pts))
		for _, p := range pts {
			if total >= maxPointsTotal {
				break
			}
			clean = append(clean, Point{X: clampF(p.X, 0, canvasW), Y: clampF(p.Y, 0, canvasH)})
			total++
		}
		if len(clean) == 0 {
			continue
		}
		out = append(out, Stroke{
			Color:  sanitizeColor(s.Color),
			Width:  clampF(s.Width, minStrokeWidth, maxStrokeWidth),
			Points: clean,
			Fill:   s.Fill,
		})
		if total >= maxPointsTotal {
			break
		}
	}
	return out
}

func sanitizeColor(c string) string {
	if hexColor.MatchString(c) {
		return c
	}
	return defaultStrokeColor
}
