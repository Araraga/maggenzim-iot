// ========================================================
// Bismillah - Backend Smart Kandang Maggenzim (Final UI Chat)
// ========================================================

// --- 1. IMPOR LIBRARY ---
require("dotenv").config();
const express = require("express");
const mqtt = require("mqtt");
const { Pool } = require("pg");
const twilio = require("twilio");
const cors = require("cors");

// --- 2. INISIALISASI ---
const app = express();

// Middleware (Body Parser & CORS)
app.use(cors()); // Mengizinkan akses dari aplikasi Flutter
app.use(express.json()); // Membaca body JSON (untuk jadwal dari Flutter)
app.use(express.urlencoded({ extended: true })); // Membaca form data (untuk Webhook Twilio)

// Koneksi Database (Neon PostgreSQL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Wajib untuk koneksi SSL ke Neon
});

// Klien Twilio (WhatsApp)
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Klien MQTT (HiveMQ Cloud)
const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  protocol: "mqtts", // Menggunakan koneksi aman (TLS/SSL)
  port: 8883,
});

// ========================================================
// --- 3. LOGIKA MQTT (PERANGKAT -> SERVER) ---
// ========================================================
mqttClient.on("connect", () => {
  console.log("✅ Terhubung ke HiveMQ Broker!");
  // Subscribe ke topik data dari semua perangkat (wildcard '+')
  mqttClient.subscribe("devices/+/data", (err) => {
    if (err) console.error("❌ Gagal subscribe topik MQTT:", err);
  });
});

// Fungsi ini berjalan setiap kali ada data sensor masuk
mqttClient.on("message", async (topic, message) => {
  try {
    const deviceId = topic.split("/")[1]; // Ambil ID dari topik

    // Parse data
    let rawData = JSON.parse(message.toString());
    let data;

    if (Array.isArray(rawData) && rawData.length > 0) {
      data = rawData[0]; // Ambil item pertama jika array
    } else if (typeof rawData === "object" && rawData !== null) {
      data = rawData; // Gunakan langsung jika objek
    } else {
      console.error(`⚠️ Format data dari ${deviceId} tidak dikenali.`);
      return;
    }

    // Validasi kelengkapan data
    // Kita terima 'gas_ppm' ATAU 'amonia' dari alat
    const gasValue = data.gas_ppm !== undefined ? data.gas_ppm : data.amonia;

    if (data.temperature === undefined || gasValue === undefined) {
      console.error(
        `⚠️ Data dari ${deviceId} tidak lengkap (butuh temperature & gas).`
      );
      return;
    }

    console.log(
      `📥 Menerima data dari ${deviceId}: Suhu=${data.temperature}, Gas=${gasValue}`
    );

    // 1. Simpan data ke database Neon
    await pool.query(
      "INSERT INTO sensor_data(device_id, temperature, humidity, gas_ppm) VALUES($1, $2, $3, $4)",
      [deviceId, data.temperature, data.humidity, gasValue]
    );

    // 2. Cek apakah perangkat terdaftar untuk notifikasi
    const deviceRes = await pool.query(
      "SELECT * FROM devices WHERE device_id = $1",
      [deviceId]
    );
    if (deviceRes.rows.length === 0) return; // Perangkat tidak dikenal, selesai.

    // 3. Cek ambang batas (Threshold) untuk peringatan
    const device = deviceRes.rows[0];
    let alertMessage = "";
    // Pastikan nilai dibandingkan sebagai angka
    if (Number(data.temperature) > Number(device.threshold_temp)) {
      alertMessage = `⚠️ PERINGATAN! Suhu di ${device.device_name} mencapai ${data.temperature}°C (Batas: ${device.threshold_temp}°C).`;
    } else if (Number(gasValue) > Number(device.threshold_gas)) {
      alertMessage = `⚠️ PERINGATAN! Kadar gas di ${device.device_name} mencapai ${gasValue} PPM (Batas: ${device.threshold_gas} PPM).`;
    }

    // 4. Jika ada peringatan, kirim WhatsApp ke pemilik
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
    console.error("❌ Error memproses pesan MQTT:", err);
  }
});

// ========================================================
// --- 4. LOGIKA WEBHOOK (WHATSAPP -> SERVER) ---
// ========================================================
app.post("/whatsapp-webhook", async (req, res) => {
  const incomingMsg = req.body.Body.toLowerCase().trim();
  const fromNumber = req.body.From; // format: whatsapp:+62...

  console.log(`💬 Pesan masuk dari ${fromNumber}: ${incomingMsg}`);

  if (incomingMsg === "cek") {
    try {
      // 1. Cari perangkat milik nomor WA tersebut
      // [PERUBAHAN] Kita tambahkan pengambilan threshold_temp dan threshold_gas
      const deviceRes = await pool.query(
        "SELECT d.device_id, d.device_name, d.threshold_temp, d.threshold_gas FROM devices d JOIN users u ON d.user_id = u.user_id WHERE u.whatsapp_number = $1 LIMIT 1",
        [fromNumber.replace("whatsapp:", "")]
      );

      if (deviceRes.rows.length === 0) {
        await sendWhatsApp(
          fromNumber,
          "Maaf, nomor WhatsApp Anda belum terdaftar di perangkat manapun."
        );
        return res.status(200).send();
      }
      const device = deviceRes.rows[0];

      // 2. Ambil 1 data sensor terakhir dari database
      const dataRes = await pool.query(
        "SELECT * FROM sensor_data WHERE device_id = $1 ORDER BY timestamp DESC LIMIT 1",
        [device.device_id]
      );

      if (dataRes.rows.length === 0) {
        await sendWhatsApp(
          fromNumber,
          `Belum ada data sensor yang terekam untuk perangkat ${device.device_name}.`
        );
        return res.status(200).send();
      }
      const latestData = dataRes.rows[0];

      // --- [BAGIAN PERUBAHAN TAMPILAN] ---

      // A. Format Data Angka
      // Menggunakan Number() untuk memastikan tipe data, lalu toFixed(1) untuk 1 desimal.
      const suhuFormatted = Number(latestData.temperature).toFixed(1);
      const kelembabanFormatted = parseInt(latestData.humidity); // Integer untuk kelembapan
      const gasFormatted = Number(latestData.gas_ppm).toFixed(1);

      // B. Tentukan Pesan Status Berdasarkan Threshold
      let statusMessage =
        "Kandang anda sedang berada dalam kondisi yang optimal.";

      // Bandingkan data aktual dengan threshold (pastikan keduanya angka)
      if (
        Number(latestData.temperature) > Number(device.threshold_temp) ||
        Number(latestData.gas_ppm) > Number(device.threshold_gas)
      ) {
        statusMessage =
          "⚠️ PERINGATAN: Kondisi kandang saat ini melewati batas aman. Harap segera dilakukan pengecekan.";
      }

      // C. Buat Pesan Balasan Sesuai Format Gambar
      // Menggunakan bullet point (•) dan baris baru (\n)
      const replyMsg = `Berikut kondisi kandang anda saat ini\n\n• Suhu — ${suhuFormatted} Derajat Celcius\n• Kelembaban— ${kelembabanFormatted}%\n• Gas NH3 — ${gasFormatted} ppm\n\n${statusMessage}`;

      // -----------------------------------

      await sendWhatsApp(fromNumber, replyMsg);
    } catch (err) {
      console.error('❌ Error membalas "cek":', err);
      await sendWhatsApp(
        fromNumber,
        "Maaf, sedang terjadi gangguan di server."
      );
    }
  }

  res.status(200).send(); // Wajib membalas 200 OK ke Twilio
});

// ========================================================
// --- 5. LOGIKA API (FLUTTER APP -> SERVER) ---
// ========================================================

// Root Endpoint (Tes koneksi)
app.get("/", (req, res) => {
  res.send("🚀 Backend Smart Kandang Maggenzim is RUNNING!");
});

// API: Validasi Perangkat (Cek apakah ID ada di DB)
app.get("/api/check-device", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id)
      return res.status(400).json({ error: "Parameter ?id= diperlukan" });

    // Ambil juga threshold untuk ditampilkan di aplikasi jika perlu
    const result = await pool.query(
      "SELECT device_id, device_name, threshold_temp, threshold_gas FROM devices WHERE device_id = $1",
      [id]
    );

    if (result.rows.length > 0) {
      // Perangkat ditemukan
      res.status(200).json({ status: "success", device: result.rows[0] });
    } else {
      // Perangkat tidak ditemukan
      res.status(404).json({ status: "error", message: "Device not found" });
    }
  } catch (err) {
    console.error("❌ Error di /api/check-device:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// API: Ambil Riwayat Data Sensor
app.get("/api/sensor-data", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id)
      return res.status(400).json({ error: "Parameter ?id= diperlukan" });

    // Ambil 20 data terakhir, urutkan dari yang paling baru
    const result = await pool.query(
      "SELECT timestamp, temperature, humidity, gas_ppm AS amonia FROM sensor_data WHERE device_id = $1 ORDER BY timestamp DESC LIMIT 20",
      [id]
    );
    res.json(result.rows); // Kirim list data ke Flutter
  } catch (err) {
    console.error("❌ Error di /api/sensor-data:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// API: Ambil Jadwal Pakan
app.get("/api/schedule", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id)
      return res.status(400).json({ error: "Parameter ?id= diperlukan" });

    const result = await pool.query(
      "SELECT times FROM schedules WHERE device_id = $1",
      [id]
    );

    if (result.rows.length > 0) {
      res.json(result.rows[0]); // Kirim: { "times": ["08:00", ...] }
    } else {
      res.json({ times: [] }); // Belum ada jadwal, kirim array kosong
    }
  } catch (err) {
    console.error("❌ Error di /api/schedule (GET):", err);
    res.status(500).json({ error: "Database error" });
  }
});

// API: Simpan/Update Jadwal Pakan
app.post("/api/schedule", async (req, res) => {
  try {
    const { id } = req.query; // ID perangkat dari URL
    const newSchedule = req.body; // Data dari Flutter: { "times": ["08:00", ...] }

    if (!id || !newSchedule || !newSchedule.times) {
      return res.status(400).json({ error: "Data jadwal tidak lengkap" });
    }

    // 1. Simpan/Update ke Database (UPSERT)
    const query = `
      INSERT INTO schedules (device_id, times) VALUES ($1, $2)
      ON CONFLICT (device_id) DO UPDATE SET times = $2, updated_at = NOW()
    `;
    await pool.query(query, [id, JSON.stringify(newSchedule.times)]);

    // 2. Kirim perintah Real-time ke Alat Pakan via MQTT
    const commandTopic = `devices/${id}/commands/set_schedule`;
    mqttClient.publish(commandTopic, JSON.stringify(newSchedule));
    console.log(`📤 Perintah update jadwal dikirim ke ${commandTopic}`);

    res.json({
      status: "success",
      message: "Jadwal berhasil disimpan dan dikirim.",
    });
  } catch (err) {
    console.error("❌ Error di /api/schedule (POST):", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================================================
// --- 6. FUNGSI BANTUAN & SERVER START ---
// ========================================================

// Fungsi bantuan untuk mengirim pesan WhatsApp via Twilio
async function sendWhatsApp(to, message) {
  try {
    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_NUMBER, // Nomor Sandbox Twilio
      to: to, // Nomor tujuan (format whatsapp:+62...)
    });
    console.log(`✅ Pesan WA terkirim ke ${to}`);
  } catch (err) {
    console.error(`❌ Gagal mengirim WA ke ${to}:`, err.message);
  }
}

// Jalankan server pada port yang ditentukan environment atau 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Server Backend berjalan di port ${PORT}`)
);
