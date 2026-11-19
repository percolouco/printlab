// PrintLab RFID — encodeur Wi-Fi d'étiquettes QIDI Box (MIFARE Classic 1K) pour ESP32 + PN532 en I2C.
// Même matériel que BoxRFID-Touch (ESP32-2432S028R « CYD » : SDA = GPIO27, SCL = GPIO22) ou n'importe quel ESP32.
// Bibliothèques Arduino : « Adafruit PN532 », « ArduinoJson » (v7).
// API (JSON) utilisée par PrintLab, réglage « Module Wi-Fi » = http://<adresse de l'ESP32> :
//   GET  /status                                   → {"ok":true,"card":bool,"uid":"hex"}
//   POST /read  {"block":4,"keys":["D3F7D3F7D3F7","FFFFFFFFFFFF"]}            → {"ok":true,"uid":"hex","data":"32 hex"}
//   POST /write {"block":4,"keys":[...],"data":"32 hex"}                       → {"ok":true,"uid":"hex"}
// Non testé sur matériel au moment de l'écriture (2026-11-14) : à valider au premier montage.

#include <WiFi.h>
#include <WebServer.h>
#include <Wire.h>
#include <Adafruit_PN532.h>
#include <ArduinoJson.h>

// ---- à adapter ----
const char *WIFI_SSID = "MonWifi";
const char *WIFI_PASS = "MotDePasse";
#define PN532_SDA 27
#define PN532_SCL 22
// -------------------

Adafruit_PN532 nfc(-1, -1, &Wire);   // I2C, sans broches IRQ / RESET
WebServer server(80);

static String hex(const uint8_t *b, size_t n) {
  static const char *H = "0123456789ABCDEF";
  String s;
  for (size_t i = 0; i < n; i++) { s += H[b[i] >> 4]; s += H[b[i] & 15]; }
  return s;
}

static bool unhex(const char *s, uint8_t *out, size_t n) {
  if (!s || strlen(s) != n * 2) return false;
  for (size_t i = 0; i < n; i++) {
    char b[3] = {s[2 * i], s[2 * i + 1], 0};
    out[i] = (uint8_t)strtoul(b, nullptr, 16);
  }
  return true;
}

static void reply(int code, JsonDocument &doc) {
  String out;
  serializeJson(doc, out);
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(code, "application/json", out);
}

static void fail(const char *msg) {
  JsonDocument d;
  d["ok"] = false;
  d["error"] = msg;
  reply(200, d);
}

// Attend une étiquette (jusqu'à 1,5 s) ; renvoie la longueur de l'UID ou 0
static uint8_t waitCard(uint8_t *uid) {
  uint8_t len = 0;
  if (!nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &len, 1500)) return 0;
  return len;
}

static bool auth(uint8_t *uid, uint8_t len, uint8_t block, JsonArray keys) {
  for (JsonVariant k : keys) {
    uint8_t key[6];
    if (!unhex(k.as<const char *>(), key, 6)) continue;
    if (nfc.mifareclassic_AuthenticateBlock(uid, len, block, 0, key)) return true;
    waitCard(uid);   // après un échec, la carte doit être resélectionnée
  }
  return false;
}

static void handleStatus() {
  uint8_t uid[7];
  uint8_t len = 0;
  bool card = nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &len, 200);
  JsonDocument d;
  d["ok"] = true;
  d["card"] = card;
  if (card) d["uid"] = hex(uid, len);
  reply(200, d);
}

static bool parseBody(JsonDocument &in) {
  if (deserializeJson(in, server.arg("plain"))) { fail("JSON invalide"); return false; }
  return true;
}

static void handleRead() {
  JsonDocument in;
  if (!parseBody(in)) return;
  uint8_t block = in["block"] | 4, uid[7], data[16];
  uint8_t len = waitCard(uid);
  if (!len) return fail("Pose l'étiquette sur le lecteur");
  if (len != 4) return fail("Ce n'est pas une MIFARE Classic 1K");
  if (!auth(uid, len, block, in["keys"].as<JsonArray>())) return fail("Authentification refusée");
  if (!nfc.mifareclassic_ReadDataBlock(block, data)) return fail("Lecture impossible");
  JsonDocument d;
  d["ok"] = true;
  d["uid"] = hex(uid, len);
  d["data"] = hex(data, 16);
  reply(200, d);
}

static void handleWrite() {
  JsonDocument in;
  if (!parseBody(in)) return;
  uint8_t block = in["block"] | 4, uid[7], data[16], back[16];
  if (block == 0 || block % 4 == 3) return fail("Bloc protégé");
  if (!unhex(in["data"] | "", data, 16)) return fail("Données : 32 caractères hexadécimaux attendus");
  uint8_t len = waitCard(uid);
  if (!len) return fail("Pose l'étiquette sur le lecteur");
  if (len != 4) return fail("Ce n'est pas une MIFARE Classic 1K");
  if (!auth(uid, len, block, in["keys"].as<JsonArray>())) return fail("Authentification refusée");
  if (!nfc.mifareclassic_WriteDataBlock(block, data)) return fail("Écriture impossible");
  if (!nfc.mifareclassic_ReadDataBlock(block, back) || memcmp(back, data, 16)) return fail("Relecture différente");
  JsonDocument d;
  d["ok"] = true;
  d["uid"] = hex(uid, len);
  reply(200, d);
}

void setup() {
  Serial.begin(115200);
  Wire.begin(PN532_SDA, PN532_SCL);
  nfc.begin();
  if (!nfc.getFirmwareVersion()) Serial.println("PN532 introuvable : vérifier le câblage et le mode I2C");
  nfc.SAMConfig();
  WiFi.mode(WIFI_STA);
  WiFi.setHostname("printlab-rfid");
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(300);
  Serial.print("PrintLab RFID : http://");
  Serial.println(WiFi.localIP());
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/read", HTTP_POST, handleRead);
  server.on("/write", HTTP_POST, handleWrite);
  server.begin();
}

void loop() { server.handleClient(); }
