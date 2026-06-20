package game

// Built-in prompt pools. These are the words a player is asked to draw when the
// host doesn't supply custom categories. Only the *prompt words* are localized
// (English or Arabic) — every other piece of game text stays English. The Arabic
// list is plain UTF-8 and round-trips through JSON and Redis unchanged.
//
// Words are kept short, concrete, and family-friendly so they're fun to draw and
// fair to guess across a mixed group.

var builtinCategoriesEN = []string{
	// originals
	"cat", "dog", "house", "tree", "car", "boat", "sun", "moon",
	"pizza", "robot", "ghost", "rocket", "guitar", "castle", "dragon",
	"flower", "fish", "snowman", "burger", "camera", "rainbow", "spider",
	"butterfly", "lighthouse", "octopus", "cactus", "balloon", "volcano",
	"umbrella", "skateboard",
	// animals
	"lion", "elephant", "bear", "rabbit", "snake", "frog", "owl", "penguin",
	"monkey", "horse", "cow", "pig", "sheep", "duck", "bee", "ant", "shark",
	"whale", "dolphin", "crab", "turtle", "snail", "fox", "wolf", "deer",
	"giraffe", "zebra", "crocodile", "dinosaur", "unicorn", "mermaid",
	// food
	"apple", "banana", "carrot", "cake", "ice cream", "donut", "egg", "bread",
	"cheese", "cookie", "watermelon", "grapes", "corn", "mushroom", "sandwich",
	"popcorn", "candy", "coffee",
	// nature
	"cloud", "star", "mountain", "river", "leaf", "fire", "snowflake",
	"tornado", "island", "planet",
	// objects & vehicles
	"key", "clock", "book", "glasses", "hat", "shoe", "shirt", "crown", "ring",
	"bell", "candle", "lamp", "chair", "table", "door", "window", "bed",
	"mirror", "scissors", "hammer", "pencil", "eye", "heart", "anchor",
	"ladder", "kite", "drum", "piano", "bicycle", "train", "airplane",
	"helicopter", "truck", "bus", "submarine", "tent", "bridge", "windmill",
	"igloo", "pyramid",
}

var builtinCategoriesAR = []string{
	// originals
	"قطة", "كلب", "منزل", "شجرة", "سيارة", "قارب", "شمس", "قمر",
	"بيتزا", "روبوت", "شبح", "صاروخ", "جيتار", "قلعة", "تنين",
	"وردة", "سمكة", "رجل ثلج", "برجر", "كاميرا", "قوس قزح", "عنكبوت",
	"فراشة", "منارة", "أخطبوط", "صبار", "بالون", "بركان",
	"مظلة", "لوح تزلج",
	// animals
	"أسد", "فيل", "دب", "أرنب", "ثعبان", "ضفدع", "بومة", "بطريق",
	"قرد", "حصان", "بقرة", "خنزير", "خروف", "بطة", "نحلة", "نملة", "قرش",
	"حوت", "دلفين", "سلطعون", "سلحفاة", "حلزون", "ثعلب", "ذئب", "غزال",
	"زرافة", "حمار وحشي", "تمساح", "ديناصور", "حصان وحيد القرن", "حورية البحر",
	// food
	"تفاحة", "موزة", "جزرة", "كعكة", "آيس كريم", "دونات", "بيضة", "خبز",
	"جبنة", "بسكويت", "بطيخ", "عنب", "ذرة", "فطر", "شطيرة",
	"فشار", "حلوى", "قهوة",
	// nature
	"غيمة", "نجمة", "جبل", "نهر", "ورقة شجر", "نار", "ندفة ثلج",
	"إعصار", "جزيرة", "كوكب",
	// objects & vehicles
	"مفتاح", "ساعة", "كتاب", "نظارة", "قبعة", "حذاء", "قميص", "تاج", "خاتم",
	"جرس", "شمعة", "مصباح", "كرسي", "طاولة", "باب", "نافذة", "سرير",
	"مرآة", "مقص", "مطرقة", "قلم رصاص", "عين", "قلب", "مرساة",
	"سلم", "طائرة ورقية", "طبل", "بيانو", "دراجة", "قطار", "طائرة",
	"مروحية", "شاحنة", "حافلة", "غواصة", "خيمة", "جسر", "طاحونة هواء",
	"كوخ ثلجي", "هرم",
}

// builtinPool returns the default prompt pool for a language. Unknown languages
// fall back to English so the game is always playable.
func builtinPool(lang Language) []string {
	if lang == LangAR {
		return builtinCategoriesAR
	}
	return builtinCategoriesEN
}
