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

let pool = null;
if (process.env.DB_HOST) {
  try {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASS || "root",
      database: process.env.DB_NAME || "alumni_system",
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 2000,
    });
  } catch (err) {
    console.warn("[AI Studio] MySQL pool creation failed — using in-memory mock:", err.message);
    pool = null;
  }
} else {
  console.warn("[AI Studio] MySQL not configured (DB_HOST unset) — using in-memory mock");
}

module.exports = {
  async query(sql, params) {
    if (!pool) {
      return mockQuery(sql, params);
    }
    try {
      return await pool.query(sql, params);
    } catch (err) {
      console.warn("[AI Studio] MySQL query failed — falling back to in-memory mock:", err.message);
      return mockQuery(sql, params);
    }
  },
};
