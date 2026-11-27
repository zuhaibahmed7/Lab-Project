const mysql = require("mysql2/promise");

// In-memory fallback store used when MySQL is unavailable in AI Studio
const mockAlumni = [];
let nextId = 1;

function matchesLike(value, pattern) {
  if (value === null || value === undefined) return false;
  const term = String(pattern).replace(/^%|%$/g, "").toLowerCase();
  return String(value).toLowerCase().includes(term);
}

async function mockQuery(sql, params = []) {
  const normalized = sql.replace(/\s+/g, " ").trim();

  if (/^INSERT INTO alumni/i.test(normalized)) {
    const [
      full_name,
      email,
      phone,
      gender,
      date_of_birth,
      student_id,
      degree,
      department,
      graduation_year,
      current_job,
      company,
      city,
      country,
      address,
      password,
    ] = params;

    const record = {
      id: nextId++,
      full_name,
      email,
      phone,
      gender,
      date_of_birth,
      student_id,
      degree,
      department,
      graduation_year,
      current_job,
      company,
      city,
      country,
      address,
      password,
      created_at: new Date(),
    };
    mockAlumni.push(record);
    return [{ insertId: record.id }, []];
  }

  if (/COUNT\(\*\)\s+AS\s+total/i.test(normalized)) {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const depts = new Set(mockAlumni.map((a) => a.department).filter(Boolean));
    const cities = new Set(mockAlumni.map((a) => a.city).filter(Boolean));
    const recent = mockAlumni.filter(
      (a) => new Date(a.created_at).getTime() >= sevenDaysAgo
    ).length;

    return [
      [
        {
          total: mockAlumni.length,
          depts: depts.size,
          cities: cities.size,
          recent,
        },
      ],
      [],
    ];
  }

  if (/WHERE email = \?/i.test(normalized)) {
    const email = params[0];
    const rows = mockAlumni.filter((a) => a.email === email);
    return [rows, []];
  }

  if (/WHERE id = \?/i.test(normalized)) {
    const id = Number(params[0]);
    const rows = mockAlumni.filter((a) => a.id === id);
    return [rows, []];
  }

  if (/WHERE full_name LIKE \?/i.test(normalized)) {
    const pattern = params[0] || "";
    const rows = mockAlumni
      .filter(
        (a) =>
          matchesLike(a.full_name, pattern) ||
          matchesLike(a.department, pattern) ||
          matchesLike(a.graduation_year, pattern) ||
          matchesLike(a.company, pattern) ||
          matchesLike(a.city, pattern)
      )
      .sort((a, b) => b.id - a.id);
    return [rows, []];
  }

  if (/ORDER BY id DESC LIMIT 5/i.test(normalized)) {
    const rows = [...mockAlumni].sort((a, b) => b.id - a.id).slice(0, 5);
    return [rows, []];
  }

  if (/ORDER BY id DESC LIMIT 1/i.test(normalized)) {
    const rows = [...mockAlumni].sort((a, b) => b.id - a.id).slice(0, 1);
    return [rows, []];
  }

  if (/FROM alumni/i.test(normalized)) {
    const rows = [...mockAlumni].sort((a, b) => b.id - a.id);
    return [rows, []];
  }

  return [[], []];
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "root",
  database: process.env.DB_NAME || "alumni_system",
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 1500,
});

const FALLBACK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "PROTOCOL_CONNECTION_LOST",
  "ER_ACCESS_DENIED_ERROR",
  "ER_BAD_DB_ERROR",
  "ER_NO_SUCH_TABLE",
]);

let useMock = false;

module.exports = {
  async query(sql, params) {
    if (useMock) {
      return mockQuery(sql, params);
    }
    try {
      return await pool.query(sql, params);
    } catch (err) {
      if (FALLBACK_CODES.has(err.code) || !err.code) {
        useMock = true;
        console.warn("MySQL unavailable — falling back to in-memory store:", err.message || err.code);
        return mockQuery(sql, params);
      }
      throw err;
    }
  },
};
