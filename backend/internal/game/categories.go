package game

// Built-in prompt pools. These are the words a player is asked to draw when the
// host doesn't supply custom categories. Only the *prompt words* are localized
// (English or Arabic) — every other piece of game text stays English. The Arabic
// list is plain UTF-8 and round-trips through JSON and Redis unchanged.
//
// Words are kept short, concrete, and family-friendly so they're fun to draw and
// fair to guess across a mixed group.

var builtinCategoriesEN = []string{
	"cat", "dog", "house", "tree", "car", "boat", "sun", "moon",
	"pizza", "robot", "ghost", "rocket", "guitar", "castle", "dragon",
	"flower", "fish", "snowman", "burger", "camera", "rainbow", "spider",
	"butterfly", "lighthouse", "octopus", "cactus", "balloon", "volcano",
	"umbrella", "skateboard",
}

var builtinCategoriesAR = []string{
	"قطة", "كلب", "منزل", "شجرة", "سيارة", "قارب", "شمس", "قمر",
	"بيتزا", "روبوت", "شبح", "صاروخ", "جيتار", "قلعة", "تنين",
	"وردة", "سمكة", "رجل ثلج", "برجر", "كاميرا", "قوس قزح", "عنكبوت",
	"فراشة", "منارة", "أخطبوط", "صبار", "بالون", "بركان",
	"مظلة", "لوح تزلج",
}

// builtinPool returns the default prompt pool for a language. Unknown languages
// fall back to English so the game is always playable.
func builtinPool(lang Language) []string {
	if lang == LangAR {
		return builtinCategoriesAR
	}
	return builtinCategoriesEN
}
