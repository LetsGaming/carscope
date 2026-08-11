import { test } from "node:test";
import assert from "node:assert/strict";
import { psToWatt, wattToPs } from "@carscope/core";
import {
  blocksBy, decodeEntities, extractDescription, germanNumber, imageUrls, parsePlace, postedAt,
  powerLabelToWatt, registrationToIso, richText, visibleText,
} from "../../packages/collector/src/text.ts";

test("German thousands separators are read correctly", () => {
  assert.equal(germanNumber("162.500 €"), 162_500);
  assert.equal(germanNumber("103.000 km"), 103_000);
  assert.equal(germanNumber("2.568 cm³"), 2_568);
  assert.equal(germanNumber("38.500\u00a0€"), 38_500);
  assert.equal(germanNumber("1,5"), 1.5);
  assert.equal(germanNumber("kein Preis"), null);
  assert.equal(germanNumber(null), null);
});

test("power labels prefer the advertised PS figure", () => {
  // Both portals print "206 kW (280 PS)". Reading the kW and converting back
  // would give 280 only by luck, and 207 for a 206 PS car.
  assert.equal(powerLabelToWatt("206 kW (280 PS)"), psToWatt(280));
  assert.equal(wattToPs(powerLabelToWatt("206 kW (280 PS)") ?? 0), 280);
  assert.equal(wattToPs(powerLabelToWatt("151 kW (206 PS)") ?? 0), 206);
  assert.equal(powerLabelToWatt("110 kW"), 110_000);
  assert.equal(powerLabelToWatt("keine Angabe"), null);
});

test("registration dates normalise to YYYY-MM whichever order they arrive in", () => {
  assert.equal(registrationToIso("EZ 05/1999"), "1999-05");
  assert.equal(registrationToIso("05-1999"), "1999-05", "AutoScout24 reports MM-YYYY");
  assert.equal(registrationToIso("1999-06"), "1999-06", "schema.org dates are YYYY-MM");
  assert.equal(registrationToIso("2002-1"), "2002-01");
  assert.equal(registrationToIso("5/1999"), "1999-05");
  assert.equal(registrationToIso("1999"), "1999");
  assert.equal(registrationToIso(null), null);
});

test("places split into country, postal code and city", () => {
  assert.deepEqual(parsePlace("AT-4030 Linz"), { country: "AT", postalCode: "4030", city: "Linz" });
  assert.deepEqual(parsePlace("57520 Steinebach (Sieg)"),
    { country: null, postalCode: "57520", city: "Steinebach (Sieg)" });
  assert.deepEqual(parsePlace(null), { country: null, postalCode: null, city: null });
});

test("visible text drops scripts, styles and markup", () => {
  const html = '<div><script>var a="<b>x</b>";</script><style>.a{}</style><p>Preis&nbsp;38.500&nbsp;&euro;</p></div>';
  assert.equal(visibleText(html), "Preis 38.500 €");
});

test("entities decode, including numeric ones", () => {
  assert.equal(decodeEntities("Gr&#252;n &amp; wei&szlig;"), "Grün & weiß");
});

test("blocksBy keeps each repeated block whole", () => {
  const blocks = blocksBy("<i>a</i><i>b</i><i>c</i>", /<i>/g);
  assert.deepEqual(blocks, ["<i>a</i>", "<i>b</i>", "<i>c</i>"]);
  assert.deepEqual(blocksBy("nothing", /<i>/g), []);
});

test("descriptions keep the line breaks the seller wrote", () => {
  const ad = `<p id="viewad-description-text" itemprop="description">Hey<br>Verbaut:<br>Greddy Gewindefahrwerk<br>RSR Downpipe<br><br>TÜV neu.<br><br>*Privat*</p>`;
  const text = extractDescription(ad, "viewad-description-text") ?? "";

  assert.equal(text.split("\n").length, 8, "a list of modifications stays a list");
  assert.ok(text.includes("Greddy Gewindefahrwerk\nRSR Downpipe"));
  assert.ok(text.includes("\n\nTÜV neu."), "blank lines between paragraphs survive");
  assert.ok(!text.includes("<br>"));
});

test("richText collapses spaces but never line breaks", () => {
  assert.equal(richText("<div>eins   zwei<br>drei</div>"), "eins zwei\ndrei");
  assert.equal(richText("<ul><li>a</li><li>b</li></ul>"), "a\nb");
  assert.equal(richText("<p>x</p>\n\n\n\n<p>y</p>"), "x\n\ny");
});

test("a gallery is read from lazy attributes, srcset and embedded json", () => {
  const page = `
    <img src="https://img.classistatic.de/a/cover?rule=$_59.AUTO">
    <img data-imgsrc="https://img.classistatic.de/a/two?rule=$_59.AUTO">
    <img srcset="https://img.classistatic.de/a/three?rule=$_2.AUTO 300w, https://img.classistatic.de/a/three?rule=$_59.AUTO 1200w">
    <script>{"images":[{"url":"https:\\/\\/img.classistatic.de\\/a\\/four?rule=$_59.AUTO"}]}</script>
    <img src="https://static.example.com/logo.png">`;
  const urls = imageUrls(page, /img\.classistatic\.de/);

  // Four pictures, not one cover; the same asset at two sizes counts once.
  assert.equal(urls.length, 4);
  assert.ok(urls.every((u) => u.includes("classistatic")), "foreign hosts are excluded");
});

test("classifieds dates resolve to the day the advert went online", () => {
  const now = new Date("2026-08-09T12:00:00Z");
  assert.equal(postedAt("Heute, 09:12", now), "2026-08-09");
  assert.equal(postedAt("Gestern, 15:40", now), "2026-08-08");
  assert.equal(postedAt("Vorgestern, 08:00", now), "2026-08-07");
  assert.equal(postedAt("07.08.2026", now), "2026-08-07");
  assert.equal(postedAt("7.8.2026, 15:40", now), "2026-08-07");
  assert.equal(postedAt("kein Datum", now), null);
  assert.equal(postedAt(null, now), null);
});

test("a gallery is found on whichever host the portal moved to", () => {
  // Kleinanzeigen serves from img.kleinanzeigen.de now, not the shared CDN, and
  // sets some pictures as CSS backgrounds rather than <img> elements.
  const page = `
    <img id="viewad-image" src="https://img.kleinanzeigen.de/api/v1/prod-ads/images/20/a?rule=$_59.AUTO">
    <div class="galleryimage-element" style="background-image: url('https://img.kleinanzeigen.de/api/v1/prod-ads/images/24/b?rule=$_59.AUTO');"></div>
    <img data-imgsrc="https://img.kleinanzeigen.de/api/v1/prod-ads/images/34/c?rule=$_59.AUTO">
    <img src="https://img.classistatic.de/api/v1/legacy/d?rule=$_59.AUTO">
    <img src="https://static.example.com/logo.png">`;

  const urls = imageUrls(page, /img\.(?:kleinanzeigen|classistatic)\.de|ebayimg\.com/);
  assert.equal(urls.length, 4, "both hosts, and the CSS background, are found");
  assert.ok(urls.every((u) => !u.endsWith("'") && !u.endsWith(")")), "no trailing CSS syntax");
});
