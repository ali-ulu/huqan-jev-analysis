# HUQAN × Jev — Tersine Mühendislik ve Entegrasyon Analizi

**Kaynak repo:** [ali-ulu/huqan](https://github.com/ali-ulu/huqan) @ `main`
**İncelenen commit:** `004ce4b` — *feat(a2a): handoff termination + durable cursor (#3478) (#3574)*
**Analiz tarihi:** 2026-10-06
**Ölçek:** 3.503 dosya, 46 MB, `lib/` altında 741 `.js` modülü
**Karşı taraf:** [TypeSafe / Jev](https://docs.typesafe.ai) — System One karar modeli (`jev-latest`)

Bu doküman, HUQAN'ın kaynak kodunu okuyup **Jev'in HUQAN içinde nereye, hangi koşullarla
ve ne kazançla girebileceğini** gerçek dosya:satır kanıtıyla çıkarır. İddiaların çoğu
çalıştırılabilir: `probe/` altındaki betikler ve `npm run check:deterministic-path`
çıktısıyla doğrulanabilir.

---

## 0. Yönetici özeti

1. **HUQAN ve Jev zıt kutuplarda tasarlanmış.** HUQAN README'nin 5. satırında kimliğini
   ilan ediyor: *"No model, no cloud, no API key."* Jev bir bulut modeli. Yani soru
   "Jev'i HUQAN'a takalım mı" değil, **"hangi katmanda takmak HUQAN'ın iddiasını bozmaz"**.

2. **Bu iddia sözlü değil, CI ile mekanik.** `scripts/check-deterministic-path.js` statik
   `require()` grafiğini gezip `llmAdapter.js`'in bildirilen yürütme giriş noktalarından
   erişilebilir olup olmadığını denetliyor. Ölçtüm, **şu an geçiyor**:
   `check:deterministic-path: OK`. Ayrıca `docs/what-huqan-learns.md:13` açıkça diyor:
   *"HUQAN has no trainable parameters."*

3. **Jev için güvenli bölge var ve ölçüldü.** Bildirilen iki giriş noktasından erişilebilen
   toplam **67** modülün **hiçbiri** `llmAdapter.js`, `lib/risk-classify.js`,
   `lib/memory-query-engine.js` veya `lib/text-safety-scorer.js` değil (yalnız
   `workflow-agent.js`'ten bakıldığında 55 modül). Yani buralara Jev eklemek deterministik
   yol kapısını **kırmaz**. (Probe: `probe/reachability-probe.js`)

4. **Asıl risk kapının kendisinde.** Jev `llmAdapter.js` dışında yeni bir "model çağıran
   modül" olacak. `MODEL_CALLING_MODULES` listesi (`scripts/check-deterministic-path.js:44`)
   yalnız `llmAdapter.js` içeriyor. Yeni modül oraya **eklenmezse** kapı yeşil kalır ama
   *yanlış şeyi ölçer* — bu, HUQAN'ın en ciddi tasarım hatası sınıfı: sessizce zayıflayan
   bir kanıt. Her Jev PR'ı bu listeyi güncellemek zorunda.

5. **En yüksek getirili üç nokta, en düşük riskten yükseğe:**
   **(A)** `lib/evidence-ranker.js` + `lib/memory-query-engine.js` rerank — okuma yolu,
   kanıt üretmez, `evidenceRanking` yeteneği zaten `false` varsayılan (`lib/kernel-contract.js:29`);
   **(B)** `lib/text-safety-scorer.js` — LLM'e giren/çıkan metni süzmek, mevcut
   `llmAdapter` ile **tutarlı bir fail-safe deseni** var; **(C)** `lib/risk-rules.js` /
   `lib/risk-classify.js` — en çok kazanç ama en yüksek risk, çünkü bunlar yetki kararını
   besliyor (`SECURITY_INVARIANTS.md` SI-01, SI-05).

6. **Kaçınılması gereken yer:** yetki sınırı. `deriveDecision`
   (`lib/risk-classify.js:43`), `runRiskRules` (`lib/risk-rules.js:284`), approval yolu ve
   `llmAdapter` öncesi/sonrası **karar veren** hiçbir yer Jev'e devredilmemeli. Jev karar
   üretmez; **sinyal** üretir, kararı yine deterministik katman verir.

---

## 1. İki sistemin kimliği

| | HUQAN | Jev (TypeSafe) |
|---|---|---|
| Ne yapar | Ajan çıktısı ile değişecek durum arasında **yerel kapı** | Durum + tipli soru → tipli karar |
| Çalışma | Yerel, deterministik, offline | Bulut, HTTP, API anahtarı |
| Çıktı | ALLOW / REVIEW / QUARANTINE / DRY-RUN ONLY / BLOCK / REJECT + Trust Receipt | Choice / Score / Noul + olasılık + güven |
| Kanıt | Her karar Trust Receipt bırakır (kanıt, politika, onaylayan) | Cevap tipli; güven dağılım yoğunluğundan |
| Bağımlılık | `better-sqlite3`, `js-yaml`, `proper-lockfile` | `typesafe-sdk` / HTTP |
| Öğrenme | Eğitilebilir parametre **yok**; üç hipotez eşiği insan onayıyla değişir | Eğitilmiş, kalibre edilmiş model |

**Temel gerilim:** HUQAN *kararın* sahibi ve kanıtın bekçisi olmak istiyor; Jev ise
*anlamı* okuyan taraf. Bu yüzden doğru mimari Jev'i **karar verici değil, sinyal üretici**
olarak konumlar. HUQAN'ın kendi terminolojisi buna zaten izin veriyor: risk motoru
`severity`/`confidence` üreten *signal* nesneleri döndürüyor (`lib/risk-rules.js`), karar
ise ayrı bir fonksiyonda (`deriveDecision`) veriliyor. Jev bu signal şeklinin doğal
kaynağı olabilir.

---

## 2. Mekanik kanıt: deterministik yol kapısı

### 2.1 Kapı ne yapıyor

`scripts/check-deterministic-path.js`:

- `ENTRY_POINTS` (`:36`): `workflow-agent.js`, `lib/experience/personal-execution-model.js`
- `MODEL_CALLING_MODULES` (`:44`): **yalnız** `llmAdapter.js`
- Bu giriş noktalarından `require()` grafiğini gezip `llmAdapter.js`'e giden yol varsa **fail**.
- Dosya başlığındaki tasarım notu (`:14-19`): *"Do not remove or weaken this check to make
  a claim true; fix the reachable path instead."*

Çalıştırılmış hali:

```console
$ node scripts/check-deterministic-path.js
check:deterministic-path: OK — no model-calling module reachable from the declared entry points.
```

### 2.2 Jev noktalarının erişilebilirliği (ölçüldü)

`probe/reachability-probe.js` HUQAN'ın kendi kapısıyla aynı `require()` grafiğini yürüyor.
İki bildirilen giriş noktası birlikte **67** modüle erişiyor (yalnız `workflow-agent.js`
ile 55). Sonuç:

| Modül | Giriş noktalarından erişilebilir? |
|---|---|
| `llmAdapter.js` | hayır |
| `lib/risk-classify.js` | hayır |
| `lib/risk-rules.js` | hayır |
| `lib/text-safety-scorer.js` | hayır |
| `lib/memory-query-engine.js` | hayır |
| `lib/memory-query-bm25.js` | hayır |
| `lib/evidence-ranker.js` | hayır |

Erişilebilen toplam modül: **55**. Yani bugünkü mimaride bu noktalara Jev eklemek
`check:deterministic-path`'i kırmıyor.

### 2.3 Kapının kör noktası (asıl tehlike)

Kapı yalnız `MODEL_CALLING_MODULES`'a bakıyor. Jev'i çağıran yeni modül (ör.
`lib/jev-ranker.js`) o listeye eklenmezse:

- kapı **yeşil kalır**,
- ama deterministik yol artık gerçekten bir model çağırıyor olabilir,
- ve kimse fark etmez.

Bu yüzden her Jev PR'ının kabul kriteri şu olmalı:

```js
// scripts/check-deterministic-path.js
const MODEL_CALLING_MODULES = Object.freeze([
  'llmAdapter.js',
  'lib/jev-adapter.js',        // ← Jev'in tek temas noktası
]);
```

Ek olarak `lib/module-reachability.js` içindeki `NOT_YET_WIRED` mekanizması (bugün 6 girdi)
ve `config/reachability-baseline.json` yeni leaf modülde ratchet tetikleyecek; bunlar
bilinen ve yönetilebilir maliyetlerdir (bkz. §6).

---

## 3. Jev'in yerini alabileceği anlamsal karar yüzeyi

HUQAN'da anlamı **elle yazılmış** kurallarla çözen modüller. Bunlar Jev'in doğal adayları.
Her satır gerçek dosya:satır kanıtı taşıyor.

| # | Modül | Yargı fonksiyonu | Heuristik kaynağı | Çıktı | ~desen |
|---|---|---|---|---|---|
| 1 | `lib/risk-rules.js` | `detectHighRiskDomain` (:141) | `HIGH_RISK_DOMAINS` 5 alan ~50 terim (:24) | sinyal + `severity`/`confidence` | **~131** |
| 2 | `lib/risk-rules.js` | `detectAbsoluteClaim` (:161) | `ABSOLUTE_TERMS` 17 (:44) | sinyal | |
| 3 | `lib/risk-rules.js` | `detectMultilingualAmbiguity` (:236) | 4 script regex + soru-kelimesi regex (:241-247) | sinyal | |
| 4 | `lib/contradiction-rules-*` (4 dosya) | `runContradictionRules` (:9) + 9 detektör | `NEGATION_TOKENS` 15, `TYPE_DISJOINTS` 8 çift, `OPPOSITION_PAIRS` 12 çift, `CAUSE_FAMILY` 12, `PREVENT_FAMILY` 15 | 9 çelişki etiketi | **~62** |
| 5 | `lib/code-change-file-classifier.js` | `classifyChangedFile` (:133) | `SURFACES` 10 satırlık **sıralı** tablo (:120) + ~53 ipucu | kategori + karar | ~53 |
| 6 | `lib/text-safety-scorer.js` | `analyseManipulation` (:46) | `MANIPULATION_RULES` 4 ağırlıklı regex (`kernel-v2-native.js:10-35`) + 4 ad-hoc regex | etiketler + `score` [0,1] | 4+4 |
| 7 | `lib/command-parser.js` | `parseCommand` (:346) | `COMMAND_RULES` ~40 **sıralı** kural (:239) | ~40 komut etiketi | ~40 |
| 8 | `lib/tool-call-gate-classify.js` | `classifyAction` (:103) | 6 aile, ~66 anahtar (`tool-call-gate-vocabulary.js`) | kategori + karar | ~66 |
| 9 | `lib/sandbox-operation-classifier.js` | `classifySandboxOperation` (:109) | `FORBIDDEN_CAPABILITY_HINTS` 18 + `EXTERNAL_NETWORK_HINTS` 9 + `DESTRUCTIVE_CLEANUP_HINTS` 8 | karar + seviye + skor | ~35 |
| 10 | `lib/external-action-guard-rules.js` | `evaluateExternalAction` (:20) | 9 shell-yan-etki regex (:9) | karar + gerekçe | 9 |
| 11 | `lib/command-exec-gate-vocabulary.js` | `evaluateCommandExec` (:35) | 6 denylist regex + 11 sarmalayıcı + 19 kritik kök + 4 injection regex | karar + eşleşme adı | ~54+12 |
| 12 | `lib/adversarial-signals.js` | `detectWeaselWords` (:112) vb. | `WEASEL_WORDS` 15, `NEGATION_TOKENS` 15, 2 attribution regex | 4 sinyal | ~56 |
| 13 | `lib/secret-patterns.js` | `findSecretsInText` (:22) | `SECRET_PATTERNS` 11 regex (:8) | bulgu + tip | 11 |
| 14 | `lib/memory-decontamination.js` | `scoreTextAgainstCorpus` (:156) | n-gram örtüşme (n=8, eşik 0.8) | olasılık + bool | 1 eşik |

### Neden bunlar kırılgan (ve Jev neden yardımcı olur)

- **Sıralı tablolar davranışın kendisi.** `code-change-file-classifier.js`'te `SURFACES`
  sıralı; ilk eşleşen kazanıyor. Satır sırasını değiştirmek kararı değiştiriyor — test
  edilmesi zor, gözden kaçması kolay bir kırılganlık.
- **Anlam literal çiftlere gömülü.** `contradiction-rules-vocabulary.js`'te anlam
  `CAUSES ↔ PREVENTS` gibi 12 elle yazılmış çift. Her paraphrase (ve Türkçe/İngilizce
  çift dillilik) bir kaçırma demek.
- **Kelime listesi ≠ anlama.** `detectHighRiskDomain` "kanser" kelimesini görünce
  `severity 0.8` veriyor (`lib/risk-rules.js:141-159`); kelimenin **iddia edilen** mi yoksa
  **sorulan** mı olduğunu ayırt etmiyor. Bu tam olarak Jev'in `Noul`/`Choice` ile
  çözebileceği türden bir ayrım.
- **Kodun kendi itirafı.** `command-exec-gate-*` yorumları denylist yaklaşımının
  obfuscation ile atlatılabileceğini kabul ediyor.

---

## 4. Mevcut emsal: HUQAN zaten opsiyonel bir LLM katmanı taşıyor

Bu, analizin en önemli kısmı: **Jev için yeni bir desen icat etmek gerekmiyor**, repo'da
uyulması gereken hazır bir emsal var.

### 4.1 Bileşenler

- `llmAdapter.js` — adaptör (kurucu :8-29, `ask` :31-51, sağlayıcılar :154-192)
- `lib/llm-proxy/` — proxy (`proxy-config.js:19-39`, `proxy-handler.js:123-303`,
  `proxy-mount.js:17-26`), HTTP'ye `lib/http/server-request-handler.js:142`'de bağlı
- Tüketiciler: `plugins/llm-memory-plugin.js:12-34`, `plugins/devil-advocate.js:107`,
  `lib/company-brain-query.js:195-225`, `lib/web-research.js:200-210`,
  `lib/kernel-learn-from-llm.js:7-92`, `lib/shield.js:22-126`

### 4.2 Yapılandırma ve varsayılanlar

| Anahtar | Yer | Varsayılan |
|---|---|---|
| `llm` yeteneği | `lib/kernel-contract.js:26` | **true** |
| `evidenceRanking` yeteneği | `lib/kernel-contract.js:29` | **false** |
| `PARANOID=1` | `llmAdapter.js:11`, `:37-40` | kapalı |
| `OPENAI_API_KEY` | `llmAdapter.js:15` | yoksa OpenAI reddedilir |

### 4.3 Fail-safe deseni (Jev'in taklit etmesi gereken)

- **Anahtar yok:** `_openai` erken döner — `{ ok: false, error: 'OPENAI_API_KEY gerekli' }`
  (`llmAdapter.js:172`). Ağa çıkılmaz.
- **Paranoid mod:** istek ağa çıkmadan reddedilir (`llmAdapter.js:37-40`).
- **Hata:** `ask` her şeyi yakalar, `{ ok: false, error }` döner (`llmAdapter.js:48-50`).
- **Arıza soğuması:** 60 sn cooldown + sınırlı hata önbelleği (`:22`, `:92-112`).
- **Ağ hatası:** proxy 502 döner (`proxy-handler.js:220-222`), 401 ayrı (`:224`).
- **Kaynak listesi korunur:** `web-research.js:186-193` — *"a down LLM must never take the
  source list down with it"*.

### 4.4 Çıktı doğrulama ve sınır

- `lib/shield.js:13` güven değerini **koerce eder**; `:49/:52/:55` kırpar (clamp).
- `lib/shield.js:59` öğrenme kapısı; `lib/kernel-learn-from-llm.js:84` `admissionRequired`.
- **LLM deterministik kapıyı atlayamaz:** shield çelişkili dal `:26-28`, proxy salt-gözlem
  `:20-21`, ve `SECURITY_INVARIANTS.md:14` **SI-01**: *"A model or untrusted execution path
  cannot self-approve a protected action."*

### 4.5 Yazılı tasarım kuralı

- `README.md:5` — *"No model, no cloud, no API key."*
- `docs/what-huqan-learns.md:13` — *"HUQAN has no trainable parameters."*; `:27-28` —
  öğrenen kısım **politika**, öğretmeni **insan onayı**.
- `docs/v5/v5-shared-trust-ecosystem-blueprint.md:100-103`
- Mekanik zorlama: `scripts/check-deterministic-path.js` + CI `.github/workflows/architecture.yml:102`

**Sonuç:** Jev entegrasyonu bu emsali birebir izlemeli — tek adaptör modülü, varsayılan
kapalı yetenek, anahtar yoksa/paranoid'de/ağ hatasında deterministik yedeğe düşme, çıktıyı
koerce+clamp etme, ve karar verme yetkisini asla almama.

---

## 5. En yüksek getirili üç entegrasyon noktası

### A. Sorgu rerank'ı (en düşük risk, net kazanç)

**Neden burada:** Okuma yolu; kanıt üretmez, yetki vermez. Zaten opsiyonel bir yetenek var
(`evidenceRanking: false`). Jev'in `rerank` cookbook'u tam bu iş için.

**Ekleme noktası (hazır):** `lib/memory-query-engine.js:264-270` — BM25'ten sonra,
sayfalamadan önce:

```js
// lib/memory-query-engine.js (mevcut, :263-268)
let ranked = null;
if (isBm25) {
  ranked = rankByBm25(results, String(contentIncludes));
  results = ranked.map((hit) => hit.record);
} else {
  sortRecords(results, orderBy, order);
}
// ← Jev rerank buraya: ranked'i sorgu-alaka olasılığıyla yeniden sırala,
//    eşik altını düşür, ama `recall` verdict'ine DOKUNMA.
```

İlgili yüzey: `lib/memory-query-bm25.js` (`rankByBm25` :82-89, skor :62-73),
`lib/evidence-ranker.js` (`rankEvidence` :25-28 — bugün yalnız tip ağırlığı),
`lib/fuzzy-normalization.js` (`analyzeFuzzyOverlap` :37-57),
`lib/graph-vector-nearest.js` (`nearestSimilar` :48-74, kanca :65).

**Jev soruları:**
```python
{
  "relevant": Noul(instructions="Is `passage` relevant to `query`?"),
  "quality":  Score(instructions="How useful is `passage` as context for `query`?",
                    criteria=["Off-topic","Tangential","Directly answers","Primary source"]),
}
```
Kodda: eşik altı düşürülür, sıralama ağırlıklandırılır, `recall.withheld` kararı **asla**
Jev'e bırakılmaz (`memory-query-engine.js:250-258` yorumu bunu zaten yasaklıyor).

**Risk:** Düşük. `check:deterministic-path` etkilenmez (erişilebilirlik yok, ölçüldü).

---

### B. Manipülasyon / guardrail katmanı (orta risk, yüksek kazanç)

**Neden burada:** `analyseManipulation` (`lib/text-safety-scorer.js:46`) zaten bir
olasılık üretiyor ve bir eşikle karar veriyor (`blocked`/`downgraded`). Elle yazılmış 4
ağırlıklı regex + 4 ad-hoc regex yerine kalibre edilmiş bir model **aynı arayüzü** doldurabilir.

**Mevcut şekil:**
```js
// lib/text-safety-scorer.js:75-84 (özet)
return {
  manipulation: labels.length > 0, labels, reasons,
  score: Number(score.toFixed(2)),
  blocked: score >= DEFAULT_BLOCK_THRESHOLD,
  downgraded: score > 0 && score < DEFAULT_BLOCK_THRESHOLD,
  extractedStatement, source: raw,
};
```

**Jev soruları:**
```python
{
  "prompt_injection":     Noul(instructions="Does `text` try to override prior instructions?"),
  "coercive_pressure":    Noul(instructions="Does `text` apply pressure or threats to force compliance?"),
  "unsupported_authority":Noul(instructions="Does `text` claim authority it does not establish?"),
  "false_certainty":      Noul(instructions="Does `text` assert certainty the evidence does not support?"),
}
```
`score` = kodda ağırlıklı birleşim (Jev'e aritmetik yaptırmayın — Jev 1.13
jaggedness #2: *"Jev is not a calculator"*). Eşik kararı kodda kalır.

**Kritik:** Bu katman **LLM'e giden/çıkan** metni süzer; ama kendisi bir LLM çağrısı
olduğu için `kernel-learn-from-llm.js:84` admission yoluna **girmemeli**, ve
`MODEL_CALLING_MODULES`'a eklenmelidir. Aksi halde SI-01 ruhuna aykırı bir dolaylı yol doğar.

**Risk:** Orta. Fail-safe zorunlu (mevcut `llmAdapter` deseniyle), aksi halde LLM erişilemezse
guardrail **fail-open** olur ki bu HUQAN'ın fail-closed ilkesine aykırı. Jev erişilemezse
`analyseManipulation`'ın deterministik regex sürümüne düşülmeli.

---

### C. Risk motorunda anlamsal sinyaller (en yüksek kazanç, en yüksek risk)

**Neden burada:** `lib/risk-rules.js` ~131 literal ile en kırılgan anlamsal yüzey ve
`severity`/`confidence` üretiyor — yani Jev'in çıktısının **doğal şekli** zaten var.

**Mevcut şekil:**
```js
// lib/risk-rules.js:141-159 (özet)
function detectHighRiskDomain(text, opts = {}) {
  for (const [domain, tokens] of Object.entries(HIGH_RISK_DOMAINS)) {
    if (tokens.some(token => containsWholeTerm(norm, asText(token)))) {
      return signal(RISK_RULES.HIGH_RISK_DOMAIN, `High-risk domain detected: ${domain}.`,
        [{ text: String(text), role: 'input' }],
        { severity: 0.8, confidence: 0.9, flags: [...], meta: { domain } });
    }
  }
  return null;
}
```

**Jev soruları:**
```python
{
  "domain": Choice(
    instructions="Which high-risk domain does the CLAIM in `text` belong to?",
    criteria={"medical": "Medical advice or treatment claims", "aviation": "...",
              "legal": "...", "financial": "...", "security": "...", "none": "No high-risk domain"},
  ),
  "is_assertion": Noul(instructions="Is `text` asserting the claim, rather than asking about it?"),
  "absolute_claim": Noul(instructions="Does `text` make an absolute or sweeping claim without qualification?"),
}
```

**Kazanç:** İki gerçek hata düzelir — (1) kelimenin **iddia mı soru mu** olduğu ayrımı
(`is_assertion`), (2) çok dilli/karma metinde kelime listesi yerine anlamsal okuma.

**Risk: YÜKSEK.** Bu çıktı yetki kararını besliyor. Şu kurallar pazarlık dışı:
- Jev **karar vermez**; yalnız `signal` üretir, `deriveDecision` (`lib/risk-classify.js:43`)
  ve `applyHardBlockRules` (`lib/risk-classify-rules.js:16`) deterministik kalır.
- Hard-block kuralları (10 dal) **asla** Jev'e taşınmaz.
- Jev erişilemezse mevcut kelime-listesi yolu aynen çalışır (fail-closed, fail-open değil).
- `severity`/`confidence` Jev'den gelse bile kodda clamp edilir (mevcut `shield.js:49-55` deseni).

**Not:** `verify-contradiction-scan.js` ve `contradiction-rules-*` için de aynı desen
geçerli, ama anlam `TYPE_DISJOINTS`/`OPPOSITION_PAIRS` gibi literal çiftlerde kodlanmış
olduğundan, Jev burada `Choice` ile **ilişki tipini** seçebilir (ör. `CAUSES` vs `PREVENTS`)
— matematiksel/sayısal çelişkiler kodda kalmalı (jaggedness #2, #3).

---

## 6. Kaçınılması gereken yerler (net sınırlar)

| Yer | Neden dokunulmamalı |
|---|---|
| `lib/risk-classify-rules.js:16` `applyHardBlockRules` | 10 sert blok dalı; yetki sınırı |
| `lib/risk-classify.js:43` `deriveDecision` | Nihai karar; Jev karar veremez |
| `lib/human-oversight-approval-runtime*.js` | İnsan onayı; Jev'in yeri yok |
| `lib/emergency-stop*.js` | SI-07; deterministik ve kalıcı olmalı |
| `lib/path-safety.js`, `lib/control-plane-paths.js` | SI-02; yol güvenliği anlamsal değil |
| `lib/receipt/*`, `lib/hash-chain.js` | Kanıt zinciri; SI-03 |
| `lib/memory-admission-gate*.js` | SI-05; kabul kararı |
| Sayısal/tarih karşılaştırmaları | Jev 1.13 jaggedness #2, #3 — kodda kalmalı |
| Sayma işlemleri | jaggedness #2: *"does not count reliably"* |

**Altın kural:** Jev **girdiyi** zenginleştirir, **kararı** vermez. Jev çıktısı
deterministik motorun gördüğü bir *sinyal* olur; Trust Receipt'te hangi sinyalin Jev'den
geldiği ayrıca işaretlenmeli ki kanıt zinciri denetlenebilir kalsın.

---

## 7. Uygulama maliyeti ve ratchet'ler

Yeni bir Jev modülü eklemek HUQAN'ın mevcut kalite kapılarını tetikler. Ölçülen maliyet:

| Kapı | Ne ister | Kanıt |
|---|---|---|
| `check:deterministic-path` | Yeni model-çağıran modül `MODEL_CALLING_MODULES`'a (`scripts/check-deterministic-path.js:44`) eklenmeli | çalıştırıldı |
| `check:dead-code` + `lib/module-reachability.js` | Yeni leaf modül için gerekçeli `NOT_YET_WIRED` girdisi (bugün 6 girdi) | `:146-252` |
| `config/reachability-baseline.json` | `unreachableTotal` / `measuredNotYetWired` ratchet'i +1 | — |
| `check:module-boundary` | `scripts/context-ownership.json` `owners`'a `{context, evidence}` (bugün 881 sahip) | okundu |
| `check:package-closure` | Runtime'da require edilen yeni modül `package.json` `files` allowlist'ine (1.238 girdi) | okundu |
| `check:file-size` | Modül boyut sınırı | `scripts/check-file-size.js` |
| `check:security-invariants` | SI-01 ile çelişmemeli; gerekiyorsa test eşlemesi güncellenmeli | `SECURITY_INVARIANTS.md:14` |

Ayrıca `lib/ai-dependency-ratio.js` (#3028) zaten **AI bağımlılık oranını** ölçüyor:
`deterministicRatio = deterministicServes / totalRequests`, `permittedFallbackShare`,
ve `llm-proxy:` mutation kayıtlarından `modelCalls`. Jev çağrıları bu ölçüme **görünür**
olmalı; olmazsa HUQAN kendi kilit metriğini yanlış raporlar. Bu, Jev entegrasyonunun
kabul kriterlerinden biri olmalı.

---

## 8. Jev 1.13'ün bilinen sınırları ve bu projeye etkisi

`docs.typesafe.ai/model-jaggedness/jev-1.13`'ten:

| # | Sınır | HUQAN'a etkisi |
|---|---|---|
| 1 | **Literal okuma** | `instructions`'a tam koşul yazılmalı; "ne demek istediğim" açıklaması talimatın eksik yarısı |
| 2 | **Matematik/sayma** | Skor ağırlıklandırma, eşik, sayım **kodda**. Jev'e aritmetik yaptırma |
| 3 | **Tarih/saat karşılaştırma** | `verify-numeric-contradictions.js` gibi yerler kodda kalır |
| 4 | **Dolaylılık (indirection)** | Çok atlamalı çıkarım beklenmemeli; `state`'e doğrudan işaret edilmeli |
| 5 | **Büyük alakasız state** | Önce filtrele; yalnız sorunun ihtiyacı olanı gönder |
| 6 | **Düşmanca içerik** | Guardrail katmanı (B) tam bu yüzden; edge case'ler deploy öncesi test edilmeli |
| 7 | **Çelişkili talimat/kriter** | Kriterler talimatla hizalı olmalı |
| 8 | **Choice seçenek sırası** | Sıralamayı değiştirip cevabın tutarlı olduğunu kontrol et — HUQAN'ın sıralı tabloları için de geçerli bir test önerisi |
| 9 | **Üretim (generation)** | Jev metin üretmez; üretim gerekiyorsa LLM kullan |

---

## 9. Önerilen yol haritası

**Faz 0 — altyapı (Jev çağrısı yok):**
1. `lib/jev-adapter.js`: tek temas noktası. `llmAdapter.js` desenini birebir izle —
   `ask` benzeri, `{ ok: false, error }` döner, paranoid/anahtar-yok/ağ-hatası durumunda
   deterministik yedeğe düşer, çıktı koerce+clamp edilir.
2. `check:deterministic-path` `MODEL_CALLING_MODULES`'a ekle.
3. `ai-dependency-ratio` ölçümüne Jev çağrılarını görünür kıl.
4. Yetenek bayrağı: `jevRanking: false` (varsayılan kapalı) — `kernel-contract.js` deseni.

**Faz 1 — A (rerank):** `lib/memory-query-engine.js:264-270`'e rerank; `recall`
kararına dokunma. En düşük risk, ölçülebilir kazanç (Jev rerank cookbook'u: top-1 %5→%18).

**Faz 2 — B (guardrail):** `analyseManipulation`'a Jev yolu; fail-closed, deterministik
yedek zorunlu.

**Faz 3 — C (risk sinyalleri):** Yalnız *sinyal* katmanı; hard-block ve `deriveDecision`
dokunulmaz. En son, en dikkatli.

**Her faz için kabul kriteri:** Jev erişilemezken tüm testler geçmeli ve davranış
bugünküyle **birebir** olmalı (yedeğe düşme kanıtı), Jev açıkken yalnız işaretli sinyaller
değişmeli, ve `check:deterministic-path` yeşil kalmalı.

---

## 10. Doğrulama

```bash
git clone https://github.com/ali-ulu/huqan && cd huqan
node scripts/check-deterministic-path.js          # OK bekleniyor
node ../huqan-jev-analysis/probe/reachability-probe.js .   # tablo çıktısı
```

Bu dokümandaki her iddia ya yukarıdaki iki komutla ya da metinde verilen `dosya:satır`
referansıyla denetlenebilir. Jev tarafı iddiaları `docs.typesafe.ai` canlı dokümanından
alınmıştır; API sözleşmesi (uç nokta `POST /v1/systemone`, env `TYPESAFE_API_KEY`) ayrıca
SDK kaynağından doğrulanmıştır.
