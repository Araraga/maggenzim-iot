// Impor library yang dibutuhkan
require("dotenv").config();
const express = require("express");
const mqtt = require("mqtt");
const { Pool } = require("pg");
const twilio = require("twilio");
const cors = require("cors"); // [TAMBAHAN] Untuk mengizinkan Flutter mengakses API

// --- Inisialisasi ---
const app = express();

// --- [TAMBAHAN] Middleware untuk API Flutter ---
app.use(cors()); // Mengizinkan akses dari domain lain (Flutter)
app.use(express.json()); // Mem-parsing JSON body dari Flutter (penting untuk 'set schedule')
// ---------------------------------------------

app.use(express.urlencoded({ extended: true })); // Ini untuk webhook Twilio (sudah ada)

// Inisialisasi koneksi database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Inisialisasi klien Twilio
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// --- Logika MQTT (Menerima Data dari Perangkat IoT) ---
const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
});

mqttClient.on("connect", () => {
  console.log("Terhubung ke HiveMQ Broker!");
  // Subscribe ke topik dimana semua perangkat mengirim data
  mqttClient.subscribe("devices/+/data", (err) => {
    if (err) console.error("Gagal subscribe:", err);
  });
});

// (Kode 'on message' Anda sudah 100% benar dan kompatibel, tidak perlu diubah)
mqttClient.on("message", async (topic, message) => {
  try {
    const deviceId = topic.split("/")[1];
    const data = JSON.parse(message.toString());

    console.log(`Menerima data dari ${deviceId}:`, data);

    // 1. Simpan data ke database
    await pool.query(
      "INSERT INTO sensor_data(device_id, temperature, humidity, gas_ppm) VALUES($1, $2, $3, $4)",
      [deviceId, data.temperature, data.humidity, data.gas_ppm]
    );

    // 2. Cek ambang batas
    const deviceRes = await pool.query(
      "SELECT * FROM devices WHERE device_id = $1",
      [deviceId]
    );
    if (deviceRes.rows.length === 0) return; // Perangkat tidak terdaftar

    const device = deviceRes.rows[0];
    let alertMessage = "";
    if (data.temperature > device.threshold_temp) {
      alertMessage = `PERINGATAN! Suhu di ${
        device.device_name || deviceId
      } mencapai ${data.temperature}°C.`;
    } else if (data.gas_ppm > device.threshold_gas) {
      alertMessage = `PERINGATAN! Kadar gas di ${
        device.device_name || deviceId
      } mencapai ${data.gas_ppm} PPM.`;
    }

    // 3. Kirim WhatsApp
    if (alertMessage) {
      const userRes = await pool.query(
        "SELECT whatsapp_number FROM users WHERE user_id = $1",
        [device.user_id]
      );
      if (userRes.rows.length > 0) {
        const userNumber = userRes.rows[0].whatsapp_number;
        await sendWhatsApp(userNumber, alertMessage);
      }
    }
  } catch (err) {
    console.error("Error memproses pesan MQTT:", err);
  }
});

// --- Endpoint Webhook (Menerima Perintah dari WhatsApp) ---
// (Kode webhook WhatsApp Anda sudah benar, tidak perlu diubah)
app.post("/whatsapp-webhook", async (req, res) => {
  const incomingMsg = req.body.Body.toLowerCase().trim();
  const fromNumber = req.body.From;

  console.log(`Pesan masuk dari ${fromNumber}: ${incomingMsg}`);

  if (incomingMsg === "cek") {
    try {
      // (Logika 'cek' Anda sudah benar)
      // 1. Cari perangkat
      const deviceRes = await pool.query(
        "SELECT d.device_id FROM devices d JOIN users u ON d.user_id = u.user_id WHERE u.whatsapp_number = $1",
        [fromNumber.replace("whatsapp:", "")]
      );
      if (deviceRes.rows.length === 0) {
        /* ... kirim pesan error ... */
      }
      const deviceId = deviceRes.rows[0].device_id;

      // 2. Ambil data terakhir
      const dataRes = await pool.query(
        "SELECT * FROM sensor_data WHERE device_id = $1 ORDER BY timestamp DESC LIMIT 1",
        [deviceId]
      );
      if (dataRes.rows.length === 0) {
        /* ... kirim pesan error ... */
      }
      const latestData = dataRes.rows[0];

      // 3. Format dan kirim balasan
      const replyMsg = `Update Terakhir untuk Perangkat ${deviceId}:\n\n🌡️ Suhu: ${
        latestData.temperature
      }°C\n💧 Lembap: ${latestData.humidity}%\n💨 Gas: ${
        latestData.gas_ppm
      } PPM\n🕒 Waktu: ${latestData.timestamp.toLocaleTimeString("id-ID")}`;
      await sendWhatsApp(fromNumber, replyMsg);
    } catch (err) {
      console.error('Error membalas "cek":', err);
      await sendWhatsApp(fromNumber, "Maaf, terjadi kesalahan di server.");
    }
  }

  res.status(200).send(); // Balas ke Twilio
});

// ===============================================
// === [TAMBAHAN] API UNTUK APLIKASI FLUTTER ===
// ===============================================

// Tes koneksi (buka URL Render Anda di browser)
app.get("/", (req, res) => {
  res.send("Backend Smart Kandang (Twilio + Flutter) is RUNNING! 🚀");
});

// Endpoint untuk mengambil data sensor (dipanggil oleh Flutter)
app.get("/api/sensor-data", async (req, res) => {
  try {
    const { id } = req.query; // Ambil ID dari Flutter
    if (!id) {
      return res.status(400).json({ error: "Parameter ?id= diperlukan" });
    }

    // Ambil 20 data terakhir
    const result = await pool.query(
      "SELECT timestamp, temperature, humidity, gas_ppm FROM sensor_data WHERE device_id = $1 ORDER BY timestamp DESC LIMIT 20",
      [id]
    );

    res.json(result.rows); // Kirim data [List] ke Flutter
  } catch (err) {
    console.error("Error di /api/sensor-data:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Endpoint untuk mengambil jadwal pakan (dipanggil oleh Flutter)
app.get("/api/schedule", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id)
      return res.status(400).json({ error: "Parameter ?id= diperlukan" });

    // (Asumsi Anda punya tabel 'schedules')
    const result = await pool.query(
      "SELECT times FROM schedules WHERE device_id = $1",
      [id]
    );

    if (result.rows.length > 0) {
      res.json(result.rows[0]); // Kirim { "times": ["07:00", ...] }
    } else {
      res.json({ times: [] }); // Belum ada jadwal
    }
  } catch (err) {
    console.error("Error di /api/schedule (GET):", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Endpoint untuk menyimpan jadwal pakan (dipanggil oleh Flutter)
app.post("/api/schedule", async (req, res) => {
  try {
    const { id } = req.query;
    const newSchedule = req.body; // { "times": ["08:00", ...] }

    if (!id)
      return res.status(400).json({ error: "Parameter ?id= diperlukan" });

    // 1. Simpan/Update ke Database (UPSERT)
    const query = `
            INSERT INTO schedules (device_id, times) VALUES ($1, $2)
            ON CONFLICT (device_id) DO UPDATE SET times = $2, updated_at = NOW()
        `;
    // (Asumsi Anda punya tabel 'schedules')
    await pool.query(query, [id, JSON.stringify(newSchedule.times)]);

    // 2. Kirim perintah Real-time ke Alat Pakan via MQTT
    const commandTopic = `devices/${id}/commands/set_schedule`;
    mqttClient.publish(commandTopic, JSON.stringify(newSchedule));
    console.log(`📤 Perintah dikirim ke ${commandTopic}`);

    res.json({ status: "success" });
  } catch (err) {
    console.error("Error di /api/schedule (POST):", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ===============================================

// Fungsi bantuan untuk mengirim WhatsApp
// (Kode ini sudah benar, tidak perlu diubah)
async function sendWhatsApp(to, message) {
  try {
    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: to,
    });
    console.log(`Pesan terkirim ke ${to}`);
  } catch (err) {
    console.error(`Gagal mengirim pesan ke ${to}:`, err.message);
  }
}

// Jalankan server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server berjalan di port ${PORT}`));
