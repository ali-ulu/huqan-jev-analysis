# HUQAN × Jev — Tersine Mühendislik Analizi

HUQAN kaynak kodunu okuyup **Jev'in HUQAN içinde nereye, hangi koşullarla ve ne kazançla
girebileceğini** gerçek `dosya:satır` kanıtıyla çıkarır.

- **Analiz:** [`ANALYSIS.md`](./ANALYSIS.md) — Türkçe, tam rapor
- **Kaynak repo:** [ali-ulu/huqan](https://github.com/ali-ulu/huqan) @ `main`
- **İncelenen commit:** `004ce4b`
- **Ölçek:** 3.503 dosya · `lib/` altında 741 `.js` modülü
- **Karşı taraf:** [TypeSafe / Jev](https://docs.typesafe.ai) — System One karar modeli

## Kısa cevap

1. HUQAN ve Jev zıt kutuplarda: HUQAN *"No model, no cloud, no API key"* diyor, Jev bir
   bulut modeli. Doğru soru "takalım mı" değil, **"hangi katmanda takmak iddiayı bozmaz"**.
2. Bu iddia CI ile mekanik olarak zorlanıyor: `scripts/check-deterministic-path.js`.
   Ölçtüm, **şu an geçiyor**.
3. Jev için güvenli bölge var: deterministik giriş noktasından erişilebilen 55 modülün
   hiçbiri Jev adayı değil. Yani buralara Jev eklemek kapıyı kırmaz.
4. **Asıl risk:** yeni Jev modülü `MODEL_CALLING_MODULES`'a eklenmezse kapı yeşil kalır ama
   yanlış şeyi ölçer — sessizce zayıflayan kanıt.
5. Jev **karar vermez, sinyal üretir**. `deriveDecision` ve hard-block kuralları
   deterministik kalır.

## Doğrulama

```bash
git clone https://github.com/ali-ulu/huqan && cd huqan
node scripts/check-deterministic-path.js                     # OK bekleniyor
node ../huqan-jev-analysis/probe/reachability-probe.js .     # erişilebilirlik tablosu
```

`probe/reachability-probe.js` HUQAN'ın kendi kapısıyla aynı `require()` grafiği yürüyüşünü
kullanır; salt-okunurdur, hedef repoya yazmaz.

## Kapsam ve sınırlar

- Bu bir **analiz**, çalışan bir entegrasyon değil. Hiçbir HUQAN dosyası değiştirilmedi.
- Jev tarafı iddiaları canlı dokümandan (`docs.typesafe.ai`) ve SDK kaynağından alındı;
  gerçek bir Jev çağrısı yapılmadı (API anahtarı yok).
- Erişilebilirlik sonucu **bu commit'e** aittir; graf değişirse probe yeniden çalıştırılmalı.
