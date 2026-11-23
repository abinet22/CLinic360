import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

export type DbDialect = 'mysql' | 'sqlite';

let mysqlPool: mysql.Pool | null = null;
let sqliteDb: Database.Database | null = null;
let activeDialect: DbDialect = 'sqlite';

interface TxContext {
  dialect: DbDialect;
  mysqlConn?: mysql.PoolConnection;
}

const txStorage = new AsyncLocalStorage<TxContext>();
let sqliteTxMutex: Promise<void> = Promise.resolve();

export function getDialect(): DbDialect {
  return activeDialect;
}

export function nowSql(d: Date = new Date()): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export async function closeDatabase(): Promise<void> {
  if (mysqlPool) {
    await mysqlPool.end();
    mysqlPool = null;
  }
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }
}

export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const ctx = txStorage.getStore();
  if (activeDialect === 'mysql') {
    if (ctx?.mysqlConn) {
      const [rows] = await ctx.mysqlConn.query(sql, params as never);
      return rows as T[];
    }
    if (mysqlPool) {
      const [rows] = await mysqlPool.query(sql, params as never);
      return rows as T[];
    }
  }
  if (!sqliteDb) throw new Error('Database not initialized');
  const stmt = sqliteDb.prepare(sql);
  return stmt.all(...params) as T[];
}

export async function queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function execute(sql: string, params: unknown[] = []): Promise<{ insertId: number; affectedRows: number }> {
  const ctx = txStorage.getStore();
  if (activeDialect === 'mysql') {
    if (ctx?.mysqlConn) {
      const [result] = (await ctx.mysqlConn.query(sql, params as never)) as unknown as [
        { insertId: number; affectedRows: number },
        unknown,
      ];
      return { insertId: Number(result.insertId || 0), affectedRows: Number(result.affectedRows || 0) };
    }
    if (mysqlPool) {
      const [result] = (await mysqlPool.query(sql, params as never)) as unknown as [
        { insertId: number; affectedRows: number },
        unknown,
      ];
      return { insertId: Number(result.insertId || 0), affectedRows: Number(result.affectedRows || 0) };
    }
  }
  if (!sqliteDb) throw new Error('Database not initialized');
  const stmt = sqliteDb.prepare(sql);
  const info = stmt.run(...params);
  return { insertId: Number(info.lastInsertRowid || 0), affectedRows: Number(info.changes || 0) };
}

export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const existing = txStorage.getStore();
  if (existing) {
    return fn();
  }

  if (activeDialect === 'mysql' && mysqlPool) {
    const conn = await mysqlPool.getConnection();
    await conn.beginTransaction();
    try {
      const result = await txStorage.run({ dialect: 'mysql', mysqlConn: conn }, fn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  if (!sqliteDb) throw new Error('Database not initialized');

  let releaseMutex!: () => void;
  const prevMutex = sqliteTxMutex;
  sqliteTxMutex = new Promise<void>((resolve) => {
    releaseMutex = resolve;
  });

  await prevMutex;
  try {
    sqliteDb.exec('BEGIN IMMEDIATE');
    try {
      const result = await txStorage.run({ dialect: 'sqlite' }, fn);
      sqliteDb.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        sqliteDb.exec('ROLLBACK');
      } catch {
        // ignore rollback error
      }
      throw err;
    }
  } finally {
    releaseMutex();
  }
}

export async function nextSequence(seqKey: string): Promise<string> {
  return withTransaction(async () => {
    const row = await queryOne<{ prefix: string; current_value: number }>(
      activeDialect === 'mysql'
        ? 'SELECT prefix, current_value FROM sequences WHERE seq_key = ? FOR UPDATE'
        : 'SELECT prefix, current_value FROM sequences WHERE seq_key = ?',
      [seqKey]
    );
    if (!row) {
      throw new Error(`Missing sequence key: ${seqKey}`);
    }
    const nextVal = row.current_value + 1;
    await execute('UPDATE sequences SET current_value = ? WHERE seq_key = ?', [nextVal, seqKey]);
    return `${row.prefix}${String(nextVal).padStart(6, '0')}`;
  });
}

function safeAddColumn(db: Database.Database, table: string, columnDef: string) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch {
    // Column already exists
  }
}

async function initSqliteSchema(db: Database.Database) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      address TEXT,
      phone TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL DEFAULT 1,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      system_role INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      module TEXT NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INTEGER NOT NULL,
      permission_id INTEGER NOT NULL,
      scope TEXT NOT NULL DEFAULT 'all',
      PRIMARY KEY (role_id, permission_id),
      FOREIGN KEY (role_id) REFERENCES roles(id),
      FOREIGN KEY (permission_id) REFERENCES permissions(id)
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL DEFAULT 1,
      department_id INTEGER NULL,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      specialty TEXT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      two_fa_enabled INTEGER NOT NULL DEFAULT 0,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT NULL,
      last_login_at TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      user_id INTEGER NOT NULL,
      role_id INTEGER NOT NULL,
      branch_id INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, role_id, branch_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (role_id) REFERENCES roles(id)
    );

    CREATE TABLE IF NOT EXISTS sequences (
      seq_key TEXT PRIMARY KEY,
      prefix TEXT NOT NULL,
      current_value INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL DEFAULT 1,
      mrn TEXT NOT NULL UNIQUE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      sex TEXT NOT NULL,
      date_of_birth TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NULL,
      address TEXT NULL,
      next_of_kin_name TEXT NULL,
      next_of_kin_phone TEXT NULL,
      blood_group TEXT NULL,
      allergies TEXT NULL,
      patient_type TEXT NOT NULL DEFAULT 'self-pay',
      payer_name TEXT NULL,
      insurance_number TEXT NULL,
      national_id TEXT NULL,
      dob_estimated INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      merged_into_id INTEGER NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by INTEGER NULL
    );

    CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(last_name, first_name);
    CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone);

    CREATE TABLE IF NOT EXISTS queue_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL DEFAULT 1,
      ticket_number TEXT NOT NULL,
      department TEXT NOT NULL DEFAULT 'OPD',
      patient_id INTEGER NOT NULL,
      visit_id INTEGER NULL,
      priority TEXT NOT NULL DEFAULT 'routine',
      status TEXT NOT NULL DEFAULT 'waiting',
      notes TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER NULL,
      called_at TEXT NULL,
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL DEFAULT 1,
      patient_id INTEGER NOT NULL,
      doctor_id INTEGER NOT NULL,
      department_id INTEGER NULL,
      appointment_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      visit_type TEXT NOT NULL DEFAULT 'consultation',
      reason TEXT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      notes TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (patient_id) REFERENCES patients(id),
      FOREIGN KEY (doctor_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL DEFAULT 1,
      visit_number TEXT NOT NULL UNIQUE,
      patient_id INTEGER NOT NULL,
      doctor_id INTEGER NULL,
      appointment_id INTEGER NULL,
      visit_type TEXT NOT NULL DEFAULT 'walk_in',
      specialty TEXT NULL,
      consultation_invoice_id INTEGER NULL,
      workflow_stage TEXT NOT NULL DEFAULT 'paid_awaiting_vitals',
      triage_priority TEXT NOT NULL DEFAULT 'routine',
      chief_complaint TEXT NULL,
      history_notes TEXT NULL,
      exam_notes TEXT NULL,
      diagnosis_code TEXT NULL,
      diagnosis_text TEXT NULL,
      treatment_plan TEXT NULL,
      follow_up_date TEXT NULL,
      status TEXT NOT NULL DEFAULT 'triage',
      closed_at TEXT NULL,
      closed_by INTEGER NULL,
      reopen_reason TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS vitals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_id INTEGER NULL,
      admission_id INTEGER NULL,
      patient_id INTEGER NOT NULL,
      bp_systolic INTEGER NULL,
      bp_diastolic INTEGER NULL,
      temperature REAL NULL,
      pulse INTEGER NULL,
      respiratory_rate INTEGER NULL,
      spo2 INTEGER NULL,
      weight_kg REAL NULL,
      height_cm REAL NULL,
      bmi REAL NULL,
      blood_glucose REAL NULL,
      early_warning_flag INTEGER NOT NULL DEFAULT 0,
      notes TEXT NULL,
      corrected_of_id INTEGER NULL,
      correction_reason TEXT NULL,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      recorded_by INTEGER NOT NULL,
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      unit_price REAL NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS lab_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      sample_type TEXT NOT NULL,
      unit TEXT NULL,
      reference_range TEXT NULL,
      price REAL NOT NULL,
      turnaround_mins INTEGER NOT NULL DEFAULT 60,
      analyte_template_json TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS imaging_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      modality TEXT NOT NULL,
      body_region TEXT NOT NULL,
      price REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS medicines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      generic_name TEXT NOT NULL,
      strength TEXT NOT NULL,
      form TEXT NOT NULL,
      unit_price REAL NOT NULL,
      stock_qty INTEGER NOT NULL DEFAULT 0,
      reorder_level INTEGER NOT NULL DEFAULT 20,
      batch_number TEXT NOT NULL,
      expiry_date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cashier_shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL DEFAULT 1,
      cashier_id INTEGER NOT NULL,
      opening_float REAL NOT NULL DEFAULT 0,
      expected_cash REAL NOT NULL DEFAULT 0,
      counted_cash REAL NULL,
      variance REAL NULL,
      status TEXT NOT NULL DEFAULT 'open',
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT NULL,
      reconciled_by INTEGER NULL,
      notes TEXT NULL,
      FOREIGN KEY (cashier_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL DEFAULT 1,
      invoice_number TEXT NOT NULL UNIQUE,
      patient_id INTEGER NOT NULL,
      visit_id INTEGER NULL,
      payer_type TEXT NOT NULL DEFAULT 'self-pay',
      payer_name TEXT NULL,
      subtotal REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      paid_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unpaid',
      notes TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      service_code TEXT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL,
      line_total REAL NOT NULL,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL DEFAULT 1,
      invoice_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      shift_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'cash',
      reference_number TEXT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER NOT NULL,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id),
      FOREIGN KEY (shift_id) REFERENCES cashier_shifts(id)
    );

    CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_number TEXT NOT NULL UNIQUE,
      payment_id INTEGER NOT NULL,
      invoice_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL,
      reprint_count INTEGER NOT NULL DEFAULT 0,
      issued_at TEXT NOT NULL DEFAULT (datetime('now')),
      issued_by INTEGER NOT NULL,
      FOREIGN KEY (payment_id) REFERENCES payments(id),
      FOREIGN KEY (invoice_id) REFERENCES invoices(id)
    );

    CREATE TABLE IF NOT EXISTS approval_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      requested_amount REAL NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by INTEGER NOT NULL,
      decided_by INTEGER NULL,
      decision_note TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT NULL,
      FOREIGN KEY (requested_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS lab_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      test_id INTEGER NOT NULL,
      invoice_id INTEGER NULL,
      ordered_by INTEGER NOT NULL,
      sample_barcode TEXT NULL,
      collected_by INTEGER NULL,
      collected_at TEXT NULL,
      result_value TEXT NULL,
      previous_result_value TEXT NULL,
      abnormal_flag TEXT NULL,
      result_notes TEXT NULL,
      panel_results_json TEXT NULL,
      rejection_reason TEXT NULL,
      amend_reason TEXT NULL,
      status TEXT NOT NULL DEFAULT 'ordered',
      entered_by INTEGER NULL,
      verified_by INTEGER NULL,
      critical_ack_by INTEGER NULL,
      critical_ack_at TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      verified_at TEXT NULL,
      FOREIGN KEY (visit_id) REFERENCES visits(id),
      FOREIGN KEY (patient_id) REFERENCES patients(id),
      FOREIGN KEY (test_id) REFERENCES lab_tests(id)
    );

    CREATE TABLE IF NOT EXISTS imaging_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      catalog_id INTEGER NOT NULL,
      invoice_id INTEGER NULL,
      ordered_by INTEGER NOT NULL,
      clinical_question TEXT NULL,
      pregnancy_checked INTEGER NOT NULL DEFAULT 0,
      exam_notes TEXT NULL,
      findings TEXT NULL,
      impression TEXT NULL,
      addendum TEXT NULL,
      repeat_reason TEXT NULL,
      status TEXT NOT NULL DEFAULT 'ordered',
      performed_by INTEGER NULL,
      reported_by INTEGER NULL,
      finalised_at TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (visit_id) REFERENCES visits(id),
      FOREIGN KEY (patient_id) REFERENCES patients(id),
      FOREIGN KEY (catalog_id) REFERENCES imaging_catalog(id)
    );

    CREATE TABLE IF NOT EXISTS prescriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      doctor_id INTEGER NOT NULL,
      invoice_id INTEGER NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      allergy_override_reason TEXT NULL,
      notes TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      dispensed_at TEXT NULL,
      dispensed_by INTEGER NULL,
      FOREIGN KEY (visit_id) REFERENCES visits(id),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS prescription_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prescription_id INTEGER NOT NULL,
      medicine_id INTEGER NOT NULL,
      dosage TEXT NOT NULL,
      frequency TEXT NOT NULL,
      duration_days INTEGER NOT NULL DEFAULT 5,
      quantity INTEGER NOT NULL,
      selected_qty INTEGER NULL,
      dispensed_qty INTEGER NOT NULL DEFAULT 0,
      external_qty INTEGER NOT NULL DEFAULT 0,
      unit_price REAL NOT NULL DEFAULT 0,
      instructions TEXT NULL,
      FOREIGN KEY (prescription_id) REFERENCES prescriptions(id),
      FOREIGN KEY (medicine_id) REFERENCES medicines(id)
    );

    CREATE TABLE IF NOT EXISTS wards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      department TEXT NOT NULL,
      daily_tariff REAL NOT NULL DEFAULT 80.0
    );

    CREATE TABLE IF NOT EXISTS beds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ward_id INTEGER NOT NULL,
      bed_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'vacant',
      FOREIGN KEY (ward_id) REFERENCES wards(id)
    );

    CREATE TABLE IF NOT EXISTS admissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admission_number TEXT NOT NULL UNIQUE,
      patient_id INTEGER NOT NULL,
      visit_id INTEGER NULL,
      admitting_doctor_id INTEGER NOT NULL,
      ward_id INTEGER NOT NULL,
      bed_id INTEGER NULL,
      admission_diagnosis TEXT NOT NULL,
      deposit_paid REAL NOT NULL DEFAULT 0,
      bed_days_billed INTEGER NOT NULL DEFAULT 0,
      last_bed_billed_at TEXT NULL,
      discharge_summary TEXT NULL,
      discharge_cleared INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ordered',
      admitted_at TEXT NOT NULL DEFAULT (datetime('now')),
      discharged_at TEXT NULL,
      FOREIGN KEY (patient_id) REFERENCES patients(id),
      FOREIGN KEY (ward_id) REFERENCES wards(id)
    );

    CREATE TABLE IF NOT EXISTS medication_administrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admission_id INTEGER NOT NULL,
      medication_order_id INTEGER NULL,
      patient_id INTEGER NOT NULL,
      medicine_name TEXT NOT NULL,
      dose TEXT NOT NULL,
      scheduled_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'due',
      reason_not_given TEXT NULL,
      administered_by_name TEXT NULL,
      administered_at TEXT NULL,
      FOREIGN KEY (admission_id) REFERENCES admissions(id)
    );

    CREATE TABLE IF NOT EXISTS store_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'medicine',
      unit TEXT NOT NULL DEFAULT 'unit',
      medicine_id INTEGER NULL,
      reorder_level INTEGER NOT NULL DEFAULT 25,
      unit_cost REAL NOT NULL DEFAULT 0,
      selling_price REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (medicine_id) REFERENCES medicines(id)
    );

    CREATE TABLE IF NOT EXISTS stock_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      location TEXT NOT NULL DEFAULT 'main_store',
      batch_number TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      qty_on_hand INTEGER NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      block_reason TEXT NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (item_id) REFERENCES store_items(id)
    );

    CREATE TABLE IF NOT EXISTS goods_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grn_number TEXT NOT NULL UNIQUE,
      supplier_name TEXT NOT NULL,
      invoice_ref TEXT NULL,
      total_cost REAL NOT NULL DEFAULT 0,
      notes TEXT NULL,
      received_by INTEGER NOT NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS grn_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grn_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      batch_number TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_cost REAL NOT NULL,
      FOREIGN KEY (grn_id) REFERENCES goods_receipts(id),
      FOREIGN KEY (item_id) REFERENCES store_items(id)
    );

    CREATE TABLE IF NOT EXISTS stock_requisitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      req_number TEXT NOT NULL UNIQUE,
      from_location TEXT NOT NULL DEFAULT 'main_store',
      to_location TEXT NOT NULL DEFAULT 'dispensary',
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT NULL,
      requested_by INTEGER NOT NULL,
      issued_by INTEGER NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      issued_at TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_requisition_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requisition_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      requested_qty INTEGER NOT NULL,
      issued_qty INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (requisition_id) REFERENCES stock_requisitions(id),
      FOREIGN KEY (item_id) REFERENCES store_items(id)
    );

    CREATE TABLE IF NOT EXISTS patient_deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deposit_number TEXT NOT NULL UNIQUE,
      patient_id INTEGER NOT NULL,
      admission_id INTEGER NULL,
      shift_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      remaining_amount REAL NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'cash',
      reference_number TEXT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      collected_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_role TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      entity_type TEXT NULL,
      entity_id INTEGER NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER NULL,
      user_name TEXT NOT NULL,
      role_at_time TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NULL,
      patient_id INTEGER NULL,
      before_json TEXT NULL,
      after_json TEXT NULL,
      reason TEXT NULL,
      ip_address TEXT NULL,
      user_agent TEXT NULL,
      branch_id INTEGER NOT NULL DEFAULT 1,
      prev_hash TEXT NOT NULL,
      row_hash TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_patients_status ON patients(status);
    CREATE INDEX IF NOT EXISTS idx_appt_doc_date ON appointments(doctor_id, appointment_date);
    CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments(patient_id);
    CREATE INDEX IF NOT EXISTS idx_visits_patient_status ON visits(patient_id, status);
    CREATE INDEX IF NOT EXISTS idx_invoices_patient_status ON invoices(patient_id, status);
    CREATE INDEX IF NOT EXISTS idx_payments_invoice_shift ON payments(invoice_id, shift_id);
    CREATE INDEX IF NOT EXISTS idx_lab_orders_visit_status ON lab_orders(visit_id, status);
    CREATE INDEX IF NOT EXISTS idx_imaging_orders_visit_status ON imaging_orders(visit_id, status);
    CREATE INDEX IF NOT EXISTS idx_prescriptions_visit_status ON prescriptions(visit_id, status);
    CREATE INDEX IF NOT EXISTS idx_admissions_patient_status ON admissions(patient_id, status);
    CREATE INDEX IF NOT EXISTS idx_batches_fefo ON stock_batches(item_id, location, status, expiry_date);
    CREATE INDEX IF NOT EXISTS idx_deposits_patient ON patient_deposits(patient_id, status);
    CREATE INDEX IF NOT EXISTS idx_notif_role_read ON notifications(target_role, is_read);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_audit_patient ON audit_logs(patient_id);
    CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_logs(occurred_at);

    CREATE TABLE IF NOT EXISTS doctor_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doctor_id INTEGER NOT NULL,
      block_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      block_type TEXT NOT NULL DEFAULT 'unavailable',
      reason TEXT NULL,
      source_leave_id INTEGER NULL,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (doctor_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_doc_blocks_date ON doctor_blocks(doctor_id, block_date);

    CREATE TABLE IF NOT EXISTS nursing_procedures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      service_id INTEGER NOT NULL,
      service_code TEXT NOT NULL,
      service_name TEXT NOT NULL,
      invoice_id INTEGER NULL,
      ordered_by INTEGER NOT NULL,
      performed_by INTEGER NULL,
      notes TEXT NULL,
      status TEXT NOT NULL DEFAULT 'ordered',
      performed_at TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (visit_id) REFERENCES visits(id),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS imaging_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      imaging_order_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      data_url TEXT NOT NULL,
      caption TEXT NULL,
      uploaded_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (imaging_order_id) REFERENCES imaging_orders(id)
    );

    CREATE TABLE IF NOT EXISTS chart_of_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      account_type TEXT NOT NULL,
      normal_balance TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_number TEXT NOT NULL UNIQUE,
      entry_date TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id INTEGER NULL,
      description TEXT NOT NULL,
      total_debit REAL NOT NULL,
      total_credit REAL NOT NULL,
      reversal_of_id INTEGER NULL,
      posted_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_je_date_source ON journal_entries(entry_date, source_type);
    CREATE INDEX IF NOT EXISTS idx_je_source_id ON journal_entries(source_type, source_id);

    CREATE TABLE IF NOT EXISTS journal_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      debit REAL NOT NULL DEFAULT 0,
      credit REAL NOT NULL DEFAULT 0,
      memo TEXT NULL,
      FOREIGN KEY (entry_id) REFERENCES journal_entries(id),
      FOREIGN KEY (account_id) REFERENCES chart_of_accounts(id)
    );

    CREATE TABLE IF NOT EXISTS supplier_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_number TEXT NOT NULL UNIQUE,
      grn_id INTEGER NULL,
      supplier_name TEXT NOT NULL,
      invoice_ref TEXT NULL,
      bill_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      total_amount REAL NOT NULL,
      paid_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      notes TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS expense_vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_number TEXT NOT NULL UNIQUE,
      expense_date TEXT NOT NULL,
      category TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      payee_name TEXT NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'bank_transfer',
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by INTEGER NOT NULL,
      approved_by INTEGER NULL,
      paid_at TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES chart_of_accounts(id)
    );

    CREATE TABLE IF NOT EXISTS insurance_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_number TEXT NOT NULL UNIQUE,
      payer_name TEXT NOT NULL,
      invoice_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      billed_amount REAL NOT NULL,
      settled_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'submitted',
      submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
      settled_at TEXT NULL,
      notes TEXT NULL,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS staff_contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      employee_code TEXT NOT NULL UNIQUE,
      department_name TEXT NOT NULL,
      contract_type TEXT NOT NULL DEFAULT 'full_time',
      base_salary REAL NOT NULL DEFAULT 0,
      housing_allowance REAL NOT NULL DEFAULT 0,
      licence_number TEXT NULL,
      licence_expiry TEXT NULL,
      contract_start TEXT NOT NULL,
      contract_end TEXT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS leave_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      leave_type TEXT NOT NULL DEFAULT 'annual',
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      days_count INTEGER NOT NULL DEFAULT 1,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by INTEGER NULL,
      decided_at TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS payroll_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_number TEXT NOT NULL UNIQUE,
      pay_month TEXT NOT NULL,
      total_gross REAL NOT NULL DEFAULT 0,
      total_deductions REAL NOT NULL DEFAULT 0,
      total_net REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      journal_entry_id INTEGER NULL,
      payment_journal_entry_id INTEGER NULL,
      created_by INTEGER NOT NULL,
      verified_by INTEGER NULL,
      verified_at TEXT NULL,
      approved_by INTEGER NULL,
      approved_at TEXT NULL,
      posted_at TEXT NULL,
      paid_by INTEGER NULL,
      paid_at TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payroll_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payroll_run_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      staff_name TEXT NOT NULL,
      role_code TEXT NOT NULL,
      base_salary REAL NOT NULL,
      allowances REAL NOT NULL,
      taxable_allowances REAL NOT NULL DEFAULT 0,
      pension_employee REAL NOT NULL DEFAULT 0,
      pension_employer REAL NOT NULL DEFAULT 0,
      paye_tax REAL NOT NULL DEFAULT 0,
      tax_deduction REAL NOT NULL,
      net_pay REAL NOT NULL,
      FOREIGN KEY (payroll_run_id) REFERENCES payroll_runs(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_by INTEGER NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS revoked_tokens (
      jti TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_2fa_challenges (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS break_glass_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );
    CREATE INDEX IF NOT EXISTS idx_bg_user_pat ON break_glass_logs(user_id, patient_id);

    CREATE TABLE IF NOT EXISTS patient_payer_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      from_type TEXT NOT NULL,
      to_type TEXT NOT NULL,
      payer_name TEXT NULL,
      reason TEXT NOT NULL,
      valid_to TEXT NULL,
      changed_by INTEGER NOT NULL,
      approved_by INTEGER NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS payment_gate_bypasses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      set_by INTEGER NOT NULL,
      reason TEXT NOT NULL,
      follow_up_status TEXT NOT NULL DEFAULT 'pending_billing',
      resolved_by INTEGER NULL,
      resolution_note TEXT NULL,
      resolved_at TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS credit_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credit_note_number TEXT NOT NULL UNIQUE,
      original_payment_id INTEGER NULL,
      receipt_id INTEGER NULL,
      invoice_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL,
      shift_id INTEGER NULL,
      journal_entry_id INTEGER NULL,
      reason TEXT NOT NULL,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (invoice_id) REFERENCES invoices(id),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS accounting_periods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_code TEXT NOT NULL UNIQUE,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      closed_by INTEGER NULL,
      closed_at TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      batch_id INTEGER NULL,
      location TEXT NOT NULL,
      movement_type TEXT NOT NULL,
      quantity_change INTEGER NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      reference_type TEXT NULL,
      reference_id INTEGER NULL,
      journal_entry_id INTEGER NULL,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (item_id) REFERENCES store_items(id)
    );

    CREATE TABLE IF NOT EXISTS medication_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admission_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      medicine_id INTEGER NULL,
      medicine_name TEXT NOT NULL,
      dose TEXT NOT NULL,
      route TEXT NOT NULL DEFAULT 'Oral',
      frequency TEXT NOT NULL DEFAULT 'BID',
      prn INTEGER NOT NULL DEFAULT 0,
      start_at TEXT NOT NULL DEFAULT (datetime('now')),
      stop_at TEXT NULL,
      ordered_by INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (admission_id) REFERENCES admissions(id),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS ward_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admission_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      doctor_id INTEGER NOT NULL,
      subjective TEXT NULL,
      objective TEXT NULL,
      assessment TEXT NOT NULL,
      plan TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (admission_id) REFERENCES admissions(id),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS nursing_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admission_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      nurse_id INTEGER NOT NULL,
      note_type TEXT NOT NULL DEFAULT 'Shift Note',
      note TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (admission_id) REFERENCES admissions(id),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS tax_brackets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lower_bound REAL NOT NULL,
      upper_bound REAL NULL,
      rate REAL NOT NULL,
      deduction REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_invoices_patient ON invoices(patient_id, status);
    CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits(patient_id, workflow_stage);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_queue_dept_status ON queue_tickets(department, status);
  `);

  // Safe migrations for pre-existing clinic360.db files
  safeAddColumn(db, 'patients', 'dob_estimated INTEGER NOT NULL DEFAULT 0');
  safeAddColumn(db, 'cashier_shifts', 'reconciled_by INTEGER NULL');
  safeAddColumn(db, 'receipts', 'reprint_count INTEGER NOT NULL DEFAULT 0');
  safeAddColumn(db, 'lab_orders', 'collected_by INTEGER NULL');
  safeAddColumn(db, 'lab_orders', 'collected_at TEXT NULL');
  safeAddColumn(db, 'lab_orders', 'previous_result_value TEXT NULL');
  safeAddColumn(db, 'lab_orders', 'rejection_reason TEXT NULL');
  safeAddColumn(db, 'lab_orders', 'amend_reason TEXT NULL');
  safeAddColumn(db, 'lab_orders', 'critical_ack_by INTEGER NULL');
  safeAddColumn(db, 'lab_orders', 'critical_ack_at TEXT NULL');
  safeAddColumn(db, 'lab_orders', 'panel_results_json TEXT NULL');
  safeAddColumn(db, 'lab_tests', 'analyte_template_json TEXT NULL');
  safeAddColumn(db, 'imaging_orders', 'repeat_reason TEXT NULL');
  safeAddColumn(db, 'prescriptions', 'allergy_override_reason TEXT NULL');
  safeAddColumn(db, 'admissions', 'bed_days_billed INTEGER NOT NULL DEFAULT 0');
  safeAddColumn(db, 'admissions', 'last_bed_billed_at TEXT NULL');
  safeAddColumn(db, 'medication_administrations', 'medication_order_id INTEGER NULL');
  safeAddColumn(db, 'users', 'two_fa_enabled INTEGER NOT NULL DEFAULT 0');
  safeAddColumn(db, 'visits', "visit_type TEXT NOT NULL DEFAULT 'walk_in'");
  safeAddColumn(db, 'visits', 'specialty TEXT NULL');
  safeAddColumn(db, 'visits', 'consultation_invoice_id INTEGER NULL');
  safeAddColumn(db, 'visits', "workflow_stage TEXT NOT NULL DEFAULT 'paid_awaiting_vitals'");
  safeAddColumn(db, 'vitals', 'admission_id INTEGER NULL');
  safeAddColumn(db, 'vitals', 'corrected_of_id INTEGER NULL');
  safeAddColumn(db, 'vitals', 'correction_reason TEXT NULL');
  safeAddColumn(db, 'prescription_items', 'selected_qty INTEGER NULL');
  safeAddColumn(db, 'prescription_items', 'external_qty INTEGER NOT NULL DEFAULT 0');
  safeAddColumn(db, 'prescription_items', 'unit_price REAL NOT NULL DEFAULT 0');
  safeAddColumn(db, 'doctor_blocks', 'source_leave_id INTEGER NULL');
  safeAddColumn(db, 'journal_entries', 'reversal_of_id INTEGER NULL');
  safeAddColumn(db, 'payroll_runs', 'payment_journal_entry_id INTEGER NULL');
  safeAddColumn(db, 'payroll_runs', 'verified_by INTEGER NULL');
  safeAddColumn(db, 'payroll_runs', 'verified_at TEXT NULL');
  safeAddColumn(db, 'payroll_runs', 'approved_by INTEGER NULL');
  safeAddColumn(db, 'payroll_runs', 'approved_at TEXT NULL');
  safeAddColumn(db, 'payroll_runs', 'paid_by INTEGER NULL');
  safeAddColumn(db, 'payroll_runs', 'paid_at TEXT NULL');
  safeAddColumn(db, 'payroll_items', 'taxable_allowances REAL NOT NULL DEFAULT 0');
  safeAddColumn(db, 'payroll_items', 'pension_employee REAL NOT NULL DEFAULT 0');
  safeAddColumn(db, 'payroll_items', 'pension_employer REAL NOT NULL DEFAULT 0');
  safeAddColumn(db, 'payroll_items', 'paye_tax REAL NOT NULL DEFAULT 0');
}

async function ensureExtraPermissionsAndSeeds() {
  const allowDemoSeed = process.env.NODE_ENV !== 'production' || process.env.SEED_DEMO === 'true';

  const defaultSettings: Array<[string, string]> = [
    ['clinic_name', 'Clinic360 Central Medical Center'],
    ['currency_code', 'USD'],
    ['currency_symbol', '$'],
    ['timezone', 'Africa/Addis_Ababa'],
    ['expense_auto_post_limit', '100'],
  ];
  for (const [k, v] of defaultSettings) {
    const exists = await queryOne('SELECT setting_key FROM system_settings WHERE setting_key = ?', [k]);
    if (!exists) {
      await execute('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)', [k, v]);
    }
  }

  const extraPerms: Array<[string, string, string]> = [
    ['order.imaging.create', 'OPD', 'Order diagnostic imaging exams'],
    ['imaging.order.read', 'Imaging', 'View imaging worklist and reports'],
    ['imaging.exam.perform', 'Imaging', 'Perform imaging scan and record exam details'],
    ['imaging.report.finalise', 'Imaging', 'Write and finalise radiology report'],
    ['ipd.admission.read', 'Inpatient', 'View wards, bed board, and admissions'],
    ['ipd.admission.create', 'Inpatient', 'Admit patient to inpatient ward'],
    ['ipd.bed.assign', 'Inpatient', 'Assign, transfer, and clear ward beds'],
    ['ipd.mar.give', 'Inpatient', 'Administer scheduled inpatient medications (MAR)'],
    ['ipd.discharge.create', 'Inpatient', 'Write discharge summary and order discharge'],
    ['ipd.discharge.clear', 'Inpatient', 'Clear paid inpatient bill for discharge'],
    ['ipd.discharge.override', 'Inpatient', 'Override unpaid inpatient discharge balance with manager approval'],
    ['ipd.bed.bill', 'Inpatient', 'Post daily ward bed charges to inpatient statement'],
    ['billing.shift.reconcile', 'Finance', 'Reconcile closed cashier shifts'],
    ['billing.deposit.create', 'Cashier', 'Collect and apply patient advance deposits'],
    ['store.item.read', 'Store', 'View main store, sub-store batches, and expiry alerts'],
    ['store.grn.create', 'Store', 'Receive supplier stock via Goods Received Note (GRN)'],
    ['store.requisition.create', 'Store', 'Submit internal stock requisitions to Main Store'],
    ['store.requisition.issue', 'Store', 'Issue stock from Main Store to departments using FEFO'],
    ['store.expiry.manage', 'Store', 'Quarantine or block expired/damaged stock batches'],
    ['audit.trace', 'Audit', 'Run end-to-end patient and user audit traces'],
    ['accounting.ledger.manage', 'Finance', 'Post journal entries, manage supplier AP, AR claims, and expense vouchers'],
    ['accounting.expense.create', 'Finance', 'Record operational expense vouchers and post to general ledger'],
    ['accounting.expense.approve', 'Finance', 'Approve and post pending operational expense vouchers'],
    ['accounting.journal.reverse', 'Finance', 'Post reversing journal entries with mandatory audit reason'],
    ['accounting.period.manage', 'Finance', 'Manage and lock monthly/quarterly accounting periods'],
    ['nursing.procedure.perform', 'Triage', 'Order and perform billable OPD nursing procedures'],
    ['hr.manage', 'HR', 'Manage staff contracts, licence expiry alerts, leave approvals, and payroll drafts'],
    ['hr.payroll.verify', 'HR', 'Verify draft payroll run calculations before manager approval'],
    ['hr.payroll.approve', 'HR', 'Approve verified payroll runs for GL posting'],
    ['hr.payroll.post', 'HR', 'Post approved payroll run accruals to General Ledger'],
    ['hr.payroll.pay', 'HR', 'Mark posted payroll run as paid and post bank disbursement journal'],
    ['hr.payslip.own', 'HR', 'View own personal monthly payslips'],
    ['hr.leave.request', 'HR', 'Submit personal staff leave request'],
    ['appointment.block.manage', 'Appointments', 'Manage clinician availability and leave blocks'],
    ['payment.gate.bypass', 'Cashier', 'Emergency bypass of self-pay payment gates with audit reason'],
    ['billing.receipt.print', 'Cashier', 'View and reprint official payment receipts'],
    ['patient.identity.update', 'Registration', 'Update patient legal name, sex, and date of birth with audit reason'],
    ['patient.payer.change', 'Cashier', 'Change patient billing category (self-pay, insurance, credit, exempt)'],
    ['triage.emergency.set', 'Triage', 'Assign emergency triage priority that unlocks emergency payment bypass'],
    ['lab.critical.ack', 'Laboratory', 'Acknowledge critical laboratory results on patient chart'],
    ['lab.sample.recollect', 'Laboratory', 'Reset rejected laboratory sample for recollection'],
    ['catalog.manage', 'Administration', 'Create and update services, tariffs, lab tests, imaging exams, medicines, and wards'],
  ];

  for (const [code, module, description] of extraPerms) {
    const existing = await queryOne<{ id: number }>('SELECT id FROM permissions WHERE code = ?', [code]);
    if (!existing) {
      await execute('INSERT INTO permissions (code, module, description) VALUES (?, ?, ?)', [code, module, description]);
    }
  }

  const rbacApplied = await queryOne<{ setting_value: string }>(
    "SELECT setting_value FROM system_settings WHERE setting_key = 'rbac_defaults_v2_applied'"
  );
  if (!rbacApplied) {
    const extraRoleBindings: Record<string, string[]> = {
      DOC: [
        'order.imaging.create', 'imaging.order.read', 'ipd.admission.read', 'ipd.admission.create',
        'ipd.discharge.create', 'nursing.procedure.perform', 'appointment.block.manage',
        'hr.leave.request', 'hr.payslip.own', 'payment.gate.bypass', 'triage.emergency.set', 'lab.critical.ack',
      ],
      WRD: [
        'ipd.admission.read', 'ipd.bed.assign', 'ipd.mar.give', 'ipd.bed.bill',
        'imaging.order.read', 'store.item.read', 'store.requisition.create', 'hr.leave.request', 'hr.payslip.own',
      ],
      IMG: ['imaging.order.read', 'imaging.exam.perform', 'imaging.report.finalise', 'hr.leave.request', 'hr.payslip.own'],
      REC: [
        'ipd.admission.read', 'appointment.block.manage', 'billing.invoice.create',
        'patient.identity.update', 'hr.leave.request', 'hr.payslip.own',
      ],
      CSH: [
        'patient.create', 'patient.update', 'visit.create', 'visit.read', 'queue.manage',
        'appointment.read', 'appointment.update', 'ipd.admission.read', 'ipd.discharge.clear',
        'ipd.bed.bill', 'billing.deposit.create', 'billing.receipt.print', 'hr.leave.request', 'hr.payslip.own',
      ],
      NUR: ['imaging.order.read', 'nursing.procedure.perform', 'triage.emergency.set', 'hr.leave.request', 'hr.payslip.own'],
      PHA: ['store.item.read', 'store.requisition.create', 'hr.leave.request', 'hr.payslip.own'],
      LAB: ['store.item.read', 'store.requisition.create', 'lab.sample.recollect', 'hr.leave.request', 'hr.payslip.own'],
      STO: ['store.item.read', 'store.grn.create', 'store.requisition.create', 'store.requisition.issue', 'store.expiry.manage', 'hr.leave.request', 'hr.payslip.own'],
      ACC: [
        'billing.shift.reconcile', 'ipd.admission.read', 'ipd.bed.bill', 'ipd.discharge.override',
        'store.item.read', 'accounting.ledger.manage', 'accounting.expense.create', 'accounting.expense.approve',
        'accounting.journal.reverse', 'accounting.period.manage', 'hr.payroll.verify', 'hr.payroll.post',
        'hr.payroll.pay', 'patient.payer.change', 'billing.receipt.print', 'hr.leave.request', 'hr.payslip.own',
      ],
      MGR: [
        'imaging.order.read', 'ipd.admission.read', 'ipd.discharge.override', 'store.item.read', 'audit.trace',
        'accounting.expense.approve', 'accounting.period.manage', 'hr.payroll.approve', 'hr.payroll.pay',
        'appointment.block.manage', 'payment.gate.bypass', 'triage.emergency.set', 'billing.receipt.print',
        'patient.identity.update', 'patient.payer.change', 'catalog.manage', 'hr.leave.request', 'hr.payslip.own',
      ],
      HRO: ['hr.manage', 'appointment.block.manage', 'hr.leave.request', 'hr.payslip.own'],
      ADM: ['patient.identity.update', 'catalog.manage', 'hr.leave.request', 'hr.payslip.own'],
      AUD: ['imaging.order.read', 'ipd.admission.read', 'store.item.read', 'audit.trace', 'hr.leave.request', 'hr.payslip.own'],
    };

    for (const [roleCode, permCodes] of Object.entries(extraRoleBindings)) {
      const role = await queryOne<{ id: number }>('SELECT id FROM roles WHERE code = ?', [roleCode]);
      if (!role) continue;
      for (const pCode of permCodes) {
        const perm = await queryOne<{ id: number }>('SELECT id FROM permissions WHERE code = ?', [pCode]);
        if (!perm) continue;
        const exists = await queryOne('SELECT 1 FROM role_permissions WHERE role_id = ? AND permission_id = ?', [
          role.id,
          perm.id,
        ]);
        if (!exists) {
          await execute('INSERT INTO role_permissions (role_id, permission_id, scope) VALUES (?, ?, ?)', [
            role.id,
            perm.id,
            'all',
          ]);
        }
      }
    }

    // Enforce least-privilege cleanup on existing DBs
    const revocations: Array<[string, string]> = [
      ['HRO', 'admin.user.manage'],
      ['REC', 'billing.invoice.read'],
      ['ADM', 'accounting.expense.create'],
      ['MGR', 'accounting.ledger.manage'],
      ['MGR', 'hr.manage'],
    ];
    for (const [rCode, pCode] of revocations) {
      await execute(
        `DELETE FROM role_permissions
         WHERE role_id = (SELECT id FROM roles WHERE code = ?)
           AND permission_id = (SELECT id FROM permissions WHERE code = ?)`,
        [rCode, pCode]
      );
    }

    await execute("INSERT INTO system_settings (setting_key, setting_value) VALUES ('rbac_defaults_v2_applied', '1')");
  }

  const extraSeqs: Array<[string, string, number]> = [
    ['ADM', 'ADM-26-', 10],
    ['GRN', 'GRN-26-', 10],
    ['REQ', 'REQ-26-', 10],
    ['DEP', 'DEP-26-', 10],
    ['JE', 'JE-26-', 10],
    ['AP', 'AP-26-', 10],
    ['EXP', 'EXP-26-', 10],
    ['CLM', 'CLM-26-', 10],
    ['PAY', 'PAY-26-', 10],
    ['CN', 'CN-26-', 10],
  ];
  for (const [seqKey, prefix, curVal] of extraSeqs) {
    const seqRow = await queryOne('SELECT seq_key FROM sequences WHERE seq_key = ?', [seqKey]);
    if (!seqRow) {
      await execute('INSERT INTO sequences (seq_key, prefix, current_value) VALUES (?, ?, ?)', [seqKey, prefix, curVal]);
    }
  }

  // Seed progressive PAYE brackets if empty
  const tbCount = await queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM tax_brackets');
  if (Number(tbCount?.cnt || 0) === 0) {
    const brackets: Array<[number, number | null, number, number]> = [
      [0, 600, 0, 0],
      [600, 1650, 0.10, 60],
      [1650, 3200, 0.15, 142.5],
      [3200, 5250, 0.20, 302.5],
      [5250, 7800, 0.25, 565],
      [7800, 10900, 0.30, 955],
      [10900, null, 0.35, 1500],
    ];
    for (const [low, high, rate, ded] of brackets) {
      await execute('INSERT INTO tax_brackets (lower_bound, upper_bound, rate, deduction, active) VALUES (?, ?, ?, ?, 1)', [
        low,
        high,
        rate,
        ded,
      ]);
    }
  }

  // Ensure open accounting period for current month
  const curMonth = new Date().toISOString().slice(0, 7);
  const existingPeriod = await queryOne('SELECT id FROM accounting_periods WHERE period_code = ?', [curMonth]);
  if (!existingPeriod) {
    const [yr, mo] = curMonth.split('-').map(Number);
    const lastDay = new Date(Date.UTC(yr, mo, 0)).toISOString().slice(0, 10);
    await execute("INSERT INTO accounting_periods (period_code, start_date, end_date, status) VALUES (?, ?, ?, 'open')", [
      curMonth,
      `${curMonth}-01`,
      lastDay,
    ]);
  }

  if (allowDemoSeed) {
    const demoPasswordHash = await bcrypt.hash('Clinic360!', 10);
    const newUsers = [
      { name: 'Grace Okonkwo, RN', email: 'wrd@clinic360.local', role: 'WRD', specialty: 'Medical & Surgical Wards' },
      { name: 'Dr. Kenji Sato', email: 'img@clinic360.local', role: 'IMG', specialty: 'Diagnostic Radiology' },
      { name: 'Dr. Leyla Farah (Lead Lab)', email: 'lab2@clinic360.local', role: 'LAB', specialty: 'Senior Lab Verifier' },
      { name: 'Samuel Osei', email: 'sto@clinic360.local', role: 'STO', specialty: 'Central Medical Store & Cold Chain' },
      { name: 'Elena Rostova', email: 'hro@clinic360.local', role: 'HRO', specialty: 'People Operations & Medical Credentialing' },
    ];
    for (const nu of newUsers) {
      const existing = await queryOne<{ id: number }>('SELECT id FROM users WHERE email = ?', [nu.email]);
      if (!existing) {
        const role = await queryOne<{ id: number }>('SELECT id FROM roles WHERE code = ?', [nu.role]);
        const res = await execute(
          'INSERT INTO users (branch_id, full_name, email, password_hash, specialty) VALUES (1, ?, ?, ?, ?)',
          [nu.name, nu.email, demoPasswordHash, nu.specialty]
        );
        if (role) {
          await execute('INSERT INTO user_roles (user_id, role_id, branch_id) VALUES (?, ?, 1)', [res.insertId, role.id]);
        }
      }
    }

    // Enforce 2FA flag on ADM, ACC, MGR users
    await execute(
      `UPDATE users SET two_fa_enabled = 1
       WHERE id IN (
         SELECT ur.user_id FROM user_roles ur
         INNER JOIN roles r ON r.id = ur.role_id
         WHERE r.code IN ('ADM', 'ACC', 'MGR')
       )`
    );
  }

  // Seed Imaging Catalog
  const imgCount = await queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM imaging_catalog');
  if (Number(imgCount?.cnt || 0) === 0) {
    const exams = [
      ['IMG-CXR', 'Chest X-Ray (PA & Lateral)', 'X-Ray', 'Thorax', 65.0],
      ['IMG-US-ABD', 'Abdominal & Pelvic Ultrasound', 'Ultrasound', 'Abdomen', 90.0],
      ['IMG-ECG', '12-Lead Resting ECG', 'ECG', 'Cardiac', 35.0],
      ['IMG-ECHO', 'Transthoracic Echocardiogram', 'Echo', 'Cardiac', 140.0],
      ['IMG-KUB', 'Kidney-Ureter-Bladder X-Ray', 'X-Ray', 'Abdomen', 60.0],
    ];
    for (const [code, name, modality, region, price] of exams) {
      await execute(
        'INSERT INTO imaging_catalog (code, name, modality, body_region, price) VALUES (?, ?, ?, ?, ?)',
        [code, name, modality, region, price]
      );
    }
  }

  // Seed Wards & Beds
  const wardCount = await queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM wards');
  if (Number(wardCount?.cnt || 0) === 0) {
    const wGen = await execute('INSERT INTO wards (code, name, department, daily_tariff) VALUES (?, ?, ?, ?)', [
      'WARD-GEN', 'General Medical Ward', 'Inpatient Medicine', 85.0,
    ]);
    const wMat = await execute('INSERT INTO wards (code, name, department, daily_tariff) VALUES (?, ?, ?, ?)', [
      'WARD-SUR', 'Surgical & Recovery Ward', 'Surgery', 110.0,
    ]);
    const wIcu = await execute('INSERT INTO wards (code, name, department, daily_tariff) VALUES (?, ?, ?, ?)', [
      'WARD-ICU', 'High Dependency / ICU', 'Critical Care', 240.0,
    ]);

    const bedDefs: Array<[number, string, string]> = [
      [wGen.insertId, 'GEN-101', 'occupied'],
      [wGen.insertId, 'GEN-102', 'vacant'],
      [wGen.insertId, 'GEN-103', 'vacant'],
      [wGen.insertId, 'GEN-104', 'cleaning'],
      [wMat.insertId, 'SUR-201', 'vacant'],
      [wMat.insertId, 'SUR-202', 'reserved'],
      [wIcu.insertId, 'ICU-01', 'vacant'],
      [wIcu.insertId, 'ICU-02', 'vacant'],
    ];
    for (const [wId, bNum, status] of bedDefs) {
      await execute('INSERT INTO beds (ward_id, bed_number, status) VALUES (?, ?, ?)', [wId, bNum, status]);
    }

    // Seed 1 active admission + MAR schedule for Evelyn Chen
    const evelyn = await queryOne<{ id: number }>("SELECT id FROM patients WHERE mrn = 'C360-000100'");
    const doc = await queryOne<{ id: number }>("SELECT id FROM users WHERE email = 'doc@clinic360.local'");
    const bed101 = await queryOne<{ id: number }>("SELECT id FROM beds WHERE bed_number = 'GEN-101'");
    if (evelyn && doc && bed101) {
      const admRes = await execute(
        `INSERT INTO admissions (admission_number, patient_id, admitting_doctor_id, ward_id, bed_id, admission_diagnosis, deposit_paid, status)
         VALUES ('ADM-26-000010', ?, ?, ?, ?, 'Hypertensive urgency & community-acquired pneumonia monitoring', 250.00, 'admitted')`,
        [evelyn.id, doc.id, wGen.insertId, bed101.id]
      );
      await execute(
        `INSERT INTO medication_administrations (admission_id, patient_id, medicine_name, dose, scheduled_time, status, administered_by_name, administered_at)
         VALUES (?, ?, 'Azithromycin 500mg IV', '500mg once daily', '08:00', 'given', 'Grace Okonkwo, RN', ?)`,
        [admRes.insertId, evelyn.id, nowSql()]
      );
      await execute(
        `INSERT INTO medication_administrations (admission_id, patient_id, medicine_name, dose, scheduled_time, status)
         VALUES (?, ?, 'Lisinopril 10mg Oral', '10mg every 12h', '20:00', 'due')`,
        [admRes.insertId, evelyn.id]
      );
    }
  }

  // Seed initial imaging order & notifications if empty
  const imgOrdCount = await queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM imaging_orders');
  if (Number(imgOrdCount?.cnt || 0) === 0) {
    const amira = await queryOne<{ id: number }>("SELECT id FROM patients WHERE mrn = 'C360-000096'");
    const v1 = await queryOne<{ id: number }>("SELECT id FROM visits WHERE visit_number = 'VIS-26-000099'");
    const doc = await queryOne<{ id: number }>("SELECT id FROM users WHERE email = 'doc@clinic360.local'");
    const cxr = await queryOne<{ id: number }>("SELECT id FROM imaging_catalog WHERE code = 'IMG-CXR'");
    const inv2 = await queryOne<{ id: number }>("SELECT id FROM invoices WHERE invoice_number = 'INV-26-000100'");
    if (amira && v1 && doc && cxr) {
      await execute(
        `INSERT INTO imaging_orders (visit_id, patient_id, catalog_id, invoice_id, ordered_by, clinical_question, status)
         VALUES (?, ?, ?, ?, ?, 'Rule out right lower lobe consolidation (productive cough, SpO2 91%)', 'ordered')`,
        [v1.id, amira.id, cxr.id, inv2?.id ?? null, doc.id]
      );
    }
  }

  const notifCount = await queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM notifications');
  if (Number(notifCount?.cnt || 0) === 0) {
    await execute(
      "INSERT INTO notifications (target_role, title, message, severity, entity_type) VALUES ('DOC', 'Urgent Triage Alert', 'Amira Kassahun (C360-000096) flagged SpO2 91% and Temp 38.6C in Triage.', 'critical', 'visit')"
    );
    await execute(
      "INSERT INTO notifications (target_role, title, message, severity, entity_type) VALUES ('ACC', 'Discount Approval Pending', 'Cashier David Kim requested $10.00 courtesy waiver on INV-26-000100.', 'warning', 'approval')"
    );
    await execute(
      "INSERT INTO notifications (target_role, title, message, severity, entity_type) VALUES ('WRD', 'Inpatient Medication Due', 'Evelyn Chen (GEN-101) has Lisinopril 10mg due at 20:00.', 'info', 'admission')"
    );
  }

  // Seed Store Items, Multi-Batch FEFO stock, GRN & Requisition if empty
  const storeCount = await queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM store_items');
  if (Number(storeCount?.cnt || 0) === 0) {
    const meds = await query<{
      id: number;
      code: string;
      generic_name: string;
      strength: string;
      form: string;
      unit_price: number;
      stock_qty: number;
      reorder_level: number;
      batch_number: string;
      expiry_date: string;
    }>('SELECT * FROM medicines ORDER BY id ASC');

    const nearExpiry20d = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    const expiry75d = new Date(Date.now() + 75 * 86400000).toISOString().slice(0, 10);
    const expired10d = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);

    const itemByCode: Record<string, number> = {};
    for (const m of meds) {
      const itemRes = await execute(
        'INSERT INTO store_items (code, name, category, unit, medicine_id, reorder_level, unit_cost, selling_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [m.code, `${m.generic_name} ${m.strength}`, 'medicine', m.form, m.id, m.reorder_level, Number((m.unit_price * 0.55).toFixed(2)), m.unit_price]
      );
      itemByCode[m.code] = itemRes.insertId;

      // Dispensary batch matching existing medicine stock
      await execute(
        'INSERT INTO stock_batches (item_id, location, batch_number, expiry_date, qty_on_hand, unit_cost, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [itemRes.insertId, 'dispensary', m.batch_number, m.expiry_date, m.stock_qty, Number((m.unit_price * 0.55).toFixed(2)), 'active']
      );

      // Additional Main Store reserve batches for FEFO replenishment
      await execute(
        'INSERT INTO stock_batches (item_id, location, batch_number, expiry_date, qty_on_hand, unit_cost, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [itemRes.insertId, 'main_store', `${m.batch_number}-MS1`, expiry75d, 250, Number((m.unit_price * 0.52).toFixed(2)), 'active']
      );
    }

    // Add a near-expiry batch in Dispensary for Azithromycin (so FEFO picks it first!) and an expired batch in Main Store for quarantine demo
    if (itemByCode['MED-AZIT']) {
      await execute(
        'INSERT INTO stock_batches (item_id, location, batch_number, expiry_date, qty_on_hand, unit_cost, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [itemByCode['MED-AZIT'], 'dispensary', 'BCH-AZIT-FEFO', nearExpiry20d, 12, 11.5, 'active']
      );
      await execute('UPDATE medicines SET stock_qty = stock_qty + 12, batch_number = ?, expiry_date = ? WHERE code = ?', [
        'BCH-AZIT-FEFO',
        nearExpiry20d,
        'MED-AZIT',
      ]);
    }
    if (itemByCode['MED-PARA']) {
      await execute(
        'INSERT INTO stock_batches (item_id, location, batch_number, expiry_date, qty_on_hand, unit_cost, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [itemByCode['MED-PARA'], 'main_store', 'BCH-OLD-EXP', expired10d, 40, 2.1, 'active']
      );
    }

    // Lab & Clinical consumables
    const consumables: Array<[string, string, string, string, number, number, number, string, string]> = [
      ['LAB-EDTA', 'EDTA Blood Tubes (100s)', 'reagent', 'Box', 10, 18.0, 0, 'LOT-LAB-901', '2027-06-30'],
      ['LAB-CBC-RG', 'Hematology Analyzer Lyse Reagent', 'reagent', 'Bottle', 5, 95.0, 0, 'LOT-HEM-44', expiry75d],
      ['CON-GLOV', 'Nitrile Exam Gloves (M, 100s)', 'consumable', 'Box', 30, 8.5, 0, 'LOT-GLV-21', '2028-01-15'],
      ['CON-SYR5', 'Sterile 5ml Syringes (100s)', 'consumable', 'Box', 20, 11.0, 0, 'LOT-SYR-18', '2028-04-30'],
    ];
    for (const [code, name, cat, unit, reorder, cost, sell, batch, exp] of consumables) {
      const res = await execute(
        'INSERT INTO store_items (code, name, category, unit, reorder_level, unit_cost, selling_price) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [code, name, cat, unit, reorder, cost, sell]
      );
      await execute(
        'INSERT INTO stock_batches (item_id, location, batch_number, expiry_date, qty_on_hand, unit_cost, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [res.insertId, cat === 'reagent' ? 'lab' : 'main_store', batch, exp, 45, cost, 'active']
      );
      if (cat === 'reagent') {
        await execute(
          'INSERT INTO stock_batches (item_id, location, batch_number, expiry_date, qty_on_hand, unit_cost, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [res.insertId, 'main_store', `${batch}-RES`, '2028-03-01', 60, cost, 'active']
        );
      }
    }

    const stoUser = await queryOne<{ id: number }>("SELECT id FROM users WHERE email = 'sto@clinic360.local'");
    const phaUser = await queryOne<{ id: number }>("SELECT id FROM users WHERE email = 'pha@clinic360.local'");
    if (stoUser) {
      const grnRes = await execute(
        "INSERT INTO goods_receipts (grn_number, supplier_name, invoice_ref, total_cost, notes, received_by) VALUES ('GRN-26-000010', 'MedSupply East Africa Ltd', 'SUP-INV-7741', 1480.00, 'Initial central warehouse replenishment', ?)",
        [stoUser.id]
      );
      if (itemByCode['MED-AMOX']) {
        await execute(
          'INSERT INTO grn_items (grn_id, item_id, batch_number, expiry_date, quantity, unit_cost) VALUES (?, ?, ?, ?, 250, 6.88)',
          [grnRes.insertId, itemByCode['MED-AMOX'], 'BCH-2604A-MS1', expiry75d]
        );
      }
    }
    if (phaUser && itemByCode['MED-AZIT']) {
      const reqRes = await execute(
        "INSERT INTO stock_requisitions (req_number, from_location, to_location, status, notes, requested_by) VALUES ('REQ-26-000010', 'main_store', 'dispensary', 'pending', 'Weekly dispensary Azithromycin replenishment', ?)",
        [phaUser.id]
      );
      await execute(
        'INSERT INTO stock_requisition_items (requisition_id, item_id, requested_qty, issued_qty) VALUES (?, ?, 60, 0)',
        [reqRes.insertId, itemByCode['MED-AZIT']]
      );
    }
  }

  // Seed initial IPD advance deposit for Evelyn Chen if none exist
  const depCount = await queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM patient_deposits');
  if (Number(depCount?.cnt || 0) === 0) {
    const evelynAdm = await queryOne<{ id: number; patient_id: number; deposit_paid: number }>(
      "SELECT id, patient_id, deposit_paid FROM admissions WHERE admission_number = 'ADM-26-000010'"
    );
    const cshUser = await queryOne<{ id: number }>("SELECT id FROM users WHERE email = 'csh@clinic360.local'");
    const shiftRow = await queryOne<{ id: number }>('SELECT id FROM cashier_shifts ORDER BY id ASC LIMIT 1');
    if (evelynAdm && cshUser && shiftRow) {
      const depAmt = Number(evelynAdm.deposit_paid || 250);
      await execute(
        `INSERT INTO patient_deposits (deposit_number, patient_id, admission_id, shift_id, amount, remaining_amount, payment_method, reference_number, status, collected_by)
         VALUES ('DEP-26-000010', ?, ?, ?, ?, ?, 'cash', 'IPD-ADV-10', 'active', ?)`,
        [evelynAdm.patient_id, evelynAdm.id, shiftRow.id, depAmt, depAmt, cshUser.id]
      );
    }
  }

  // Seed multi-analyte panel templates on LAB-CBC, LAB-BMP, LAB-LFT
  const panelTemplates: Record<string, Array<{ code: string; name: string; unit: string; refRange: string }>> = {
    'LAB-CBC': [
      { code: 'WBC', name: 'White Blood Cell Count', unit: '10^9/L', refRange: '4.0 - 11.0' },
      { code: 'HGB', name: 'Hemoglobin', unit: 'g/dL', refRange: '12.0 - 17.5' },
      { code: 'PLT', name: 'Platelets', unit: '10^9/L', refRange: '150 - 400' },
      { code: 'NEUT', name: 'Neutrophils', unit: '%', refRange: '40 - 75' },
    ],
    'LAB-BMP': [
      { code: 'GLU', name: 'Fasting Glucose', unit: 'mmol/L', refRange: '3.9 - 5.5' },
      { code: 'NA', name: 'Sodium (Na+)', unit: 'mmol/L', refRange: '135 - 145' },
      { code: 'K', name: 'Potassium (K+)', unit: 'mmol/L', refRange: '3.5 - 5.0' },
      { code: 'CREA', name: 'Serum Creatinine', unit: 'mg/dL', refRange: '0.6 - 1.3' },
    ],
    'LAB-LFT': [
      { code: 'ALT', name: 'Alanine Aminotransferase (ALT)', unit: 'U/L', refRange: '7 - 56' },
      { code: 'AST', name: 'Aspartate Aminotransferase (AST)', unit: 'U/L', refRange: '10 - 40' },
      { code: 'ALP', name: 'Alkaline Phosphatase (ALP)', unit: 'U/L', refRange: '44 - 147' },
      { code: 'TBIL', name: 'Total Bilirubin', unit: 'mg/dL', refRange: '0.1 - 1.2' },
    ],
  };
  for (const [code, tmpl] of Object.entries(panelTemplates)) {
    await execute('UPDATE lab_tests SET analyte_template_json = ? WHERE code = ? AND analyte_template_json IS NULL', [
      JSON.stringify(tmpl),
      code,
    ]);
  }

  const nursingSeeds: Array<[string, string, string, number]> = [
    ['NUR-INJ', 'Intramuscular Injection & Dressing', 'procedure', 18.0],
    ['NUR-NEB', 'Nebulization Therapy', 'procedure', 22.0],
    ['CON-GEN', 'General Medicine Consultation', 'consultation', 45.0],
    ['CON-PED', 'Pediatrics Consultation', 'consultation', 55.0],
    ['CON-GYN', 'Gynecology Consultation', 'consultation', 65.0],
    ['CON-DERM', 'Dermatology Consultation', 'consultation', 60.0],
  ];
  for (const [code, name, cat, price] of nursingSeeds) {
    const exists = await queryOne<{ id: number }>('SELECT id FROM services WHERE code = ?', [code]);
    if (!exists) {
      await execute('INSERT INTO services (code, name, category, unit_price) VALUES (?, ?, ?, ?)', [code, name, cat, price]);
    }
  }

  // Seed sample doctor availability block (tomorrow afternoon surgery/leave block for Dr. Bekele)
  const blockCount = await queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM doctor_blocks');
  if (Number(blockCount?.cnt || 0) === 0) {
    const doc2 = await queryOne<{ id: number }>("SELECT id FROM users WHERE email = 'doc2@clinic360.local'");
    const admUser = await queryOne<{ id: number }>("SELECT id FROM users WHERE email = 'adm@clinic360.local'");
    const todayStr = new Date().toISOString().slice(0, 10);
    if (doc2 && admUser) {
      await execute(
        `INSERT INTO doctor_blocks (doctor_id, block_date, start_time, end_time, block_type, reason, created_by)
         VALUES (?, ?, '14:00', '16:30', 'off_duty', 'Pediatric ward rounds & CME conference', ?)`,
        [doc2.id, todayStr, admUser.id]
      );
    }
  }

  // Seed sample vector Chest X-Ray schematic attachment for imaging order #1 if none exist
  const imgAttCount = await queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM imaging_attachments');
  if (Number(imgAttCount?.cnt || 0) === 0) {
    const imgOrd = await queryOne<{ id: number }>('SELECT id FROM imaging_orders ORDER BY id ASC LIMIT 1');
    const imgUser = await queryOne<{ id: number }>("SELECT id FROM users WHERE email = 'img@clinic360.local'");
    if (imgOrd && imgUser) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 320" width="400" height="320"><rect width="400" height="320" fill="#0f172a"/><ellipse cx="145" cy="155" rx="58" ry="96" fill="#1e293b" stroke="#64748b" stroke-width="2"/><ellipse cx="255" cy="155" rx="58" ry="96" fill="#1e293b" stroke="#64748b" stroke-width="2"/><rect x="192" y="38" width="16" height="240" rx="6" fill="#94a3b8" opacity="0.55"/><path d="M100 100 Q200 72 300 100 M95 130 Q200 104 305 130 M95 162 Q200 138 305 162 M100 194 Q200 172 300 194" stroke="#cbd5e1" stroke-width="2.5" fill="none" opacity="0.45"/><circle cx="132" cy="195" r="22" fill="#e2e8f0" opacity="0.22"/><text x="16" y="24" fill="#94a3b8" font-family="monospace" font-size="11">PA CHEST · CLINIC360 PACS PREVIEW</text><text x="16" y="304" fill="#64748b" font-family="monospace" font-size="10">R                                    L</text></svg>`;
      const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
      await execute(
        'INSERT INTO imaging_attachments (imaging_order_id, file_name, mime_type, data_url, caption, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
        [imgOrd.id, 'cxr_pa_baseline_preview.svg', 'image/svg+xml', dataUrl, 'PA Chest Radiograph Reference Study', imgUser.id]
      );
    }
  }

  // Seed Chart of Accounts & initial Accounting Ledger (ACC)
  const extraCoa: Array<[string, string, string, string]> = [
    ['1150', 'Patient Accounts Receivable (Self-Pay)', 'asset', 'debit'],
    ['2210', 'PAYE Income Tax Payable', 'liability', 'credit'],
    ['2220', 'Employee & Employer Pension Payable', 'liability', 'credit'],
    ['5020', 'Inventory Expiry & Shrinkage Loss', 'expense', 'debit'],
    ['5300', 'Medical Equipment Maintenance & Repairs', 'expense', 'debit'],
    ['5400', 'Office, IT & Operational Admin Expense', 'expense', 'debit'],
  ];
  const coaCount = await queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM chart_of_accounts');
  if (Number(coaCount?.cnt || 0) > 0) {
    for (const [code, name, type, normal] of extraCoa) {
      const exists = await queryOne<{ id: number }>('SELECT id FROM chart_of_accounts WHERE code = ?', [code]);
      if (!exists) {
        await execute(
          'INSERT INTO chart_of_accounts (code, name, account_type, normal_balance) VALUES (?, ?, ?, ?)',
          [code, name, type, normal]
        );
      }
    }
  }
  if (Number(coaCount?.cnt || 0) === 0) {
    const accounts: Array<[string, string, string, string]> = [
      ['1010', 'Cash on Hand & Till Drawer', 'asset', 'debit'],
      ['1020', 'Operating Bank & Card Settlement', 'asset', 'debit'],
      ['1100', 'Insurance & Corporate Accounts Receivable', 'asset', 'debit'],
      ['1150', 'Patient Accounts Receivable (Self-Pay)', 'asset', 'debit'],
      ['1200', 'Medical Store & Pharmacy Inventory', 'asset', 'debit'],
      ['2010', 'Patient Advance Deposits Liability', 'liability', 'credit'],
      ['2100', 'Supplier Accounts Payable', 'liability', 'credit'],
      ['2200', 'Net Payroll & Statutory Payables', 'liability', 'credit'],
      ['2210', 'PAYE Income Tax Payable', 'liability', 'credit'],
      ['2220', 'Employee & Employer Pension Payable', 'liability', 'credit'],
      ['4010', 'Consultation & OPD Revenue', 'revenue', 'credit'],
      ['4020', 'Laboratory & Diagnostic Imaging Revenue', 'revenue', 'credit'],
      ['4030', 'Dispensary Pharmacy Sales Revenue', 'revenue', 'credit'],
      ['4040', 'Inpatient Ward & Nursing Procedures Revenue', 'revenue', 'credit'],
      ['5010', 'Cost of Medical Supplies & Drugs', 'expense', 'debit'],
      ['5020', 'Inventory Expiry & Shrinkage Loss', 'expense', 'debit'],
      ['5100', 'Staff Salaries & Benefits Expense', 'expense', 'debit'],
      ['5200', 'Clinic Utilities, Maintenance & Admin Expense', 'expense', 'debit'],
      ['5300', 'Medical Equipment Maintenance & Repairs', 'expense', 'debit'],
      ['5400', 'Office, IT & Operational Admin Expense', 'expense', 'debit'],
    ];
    for (const [code, name, type, normal] of accounts) {
      await execute(
        'INSERT INTO chart_of_accounts (code, name, account_type, normal_balance) VALUES (?, ?, ?, ?)',
        [code, name, type, normal]
      );
    }

    const coaByCode: Record<string, number> = {};
    const coaRows = await query<{ id: number; code: string }>('SELECT id, code FROM chart_of_accounts');
    for (const r of coaRows) coaByCode[r.code] = r.id;

    const accUser = await queryOne<{ id: number }>("SELECT id FROM users WHERE email = 'acc@clinic360.local'");
    const cshUser = await queryOne<{ id: number }>("SELECT id FROM users WHERE email = 'csh@clinic360.local'");
    const todayStr = new Date().toISOString().slice(0, 10);
    const due30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

    if (accUser) {
      // Seed JE-26-000009 (cash consultation INV-26-000099) & JE-26-000010 (GRN-26-000010 Inventory/AP)
      const je1 = await execute(
        `INSERT INTO journal_entries (entry_number, entry_date, source_type, source_id, description, total_debit, total_credit, posted_by)
         VALUES ('JE-26-000009', ?, 'cashier_payment', 1, 'Cash collection INV-26-000099 (OPD Consultation)', 45.00, 45.00, ?)`,
        [todayStr, cshUser?.id || accUser.id]
      );
      await execute('INSERT INTO journal_lines (entry_id, account_id, debit, credit, memo) VALUES (?, ?, 45.00, 0, ?)', [
        je1.insertId, coaByCode['1010'], 'Cash drawer receipt RCP-26-000099'
      ]);
      await execute('INSERT INTO journal_lines (entry_id, account_id, debit, credit, memo) VALUES (?, ?, 0, 45.00, ?)', [
        je1.insertId, coaByCode['4010'], 'OPD consultation fee earned'
      ]);

      const grnRow = await queryOne<{ id: number; total_cost: number }>("SELECT id, total_cost FROM goods_receipts WHERE grn_number = 'GRN-26-000010'");
      if (grnRow) {
        const je2 = await execute(
          `INSERT INTO journal_entries (entry_number, entry_date, source_type, source_id, description, total_debit, total_credit, posted_by)
           VALUES ('JE-26-000010', ?, 'grn_receipt', ?, 'GRN-26-000010 stock receipt from MedSupply East Africa Ltd', ?, ?, ?)`,
          [todayStr, grnRow.id, grnRow.total_cost, grnRow.total_cost, accUser.id]
        );
        await execute('INSERT INTO journal_lines (entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, 0, ?)', [
          je2.insertId, coaByCode['1200'], grnRow.total_cost, 'Medical inventory received into Main Store'
        ]);
        await execute('INSERT INTO journal_lines (entry_id, account_id, debit, credit, memo) VALUES (?, ?, 0, ?, ?)', [
          je2.insertId, coaByCode['2100'], grnRow.total_cost, 'Supplier payable SUP-INV-7741'
        ]);

        await execute(
          `INSERT INTO supplier_bills (bill_number, grn_id, supplier_name, invoice_ref, bill_date, due_date, total_amount, paid_amount, status, notes)
           VALUES ('AP-26-000010', ?, 'MedSupply East Africa Ltd', 'SUP-INV-7741', ?, ?, ?, 0.00, 'open', 'Net-30 warehouse replenishment invoice')`,
          [grnRow.id, todayStr, due30, grnRow.total_cost]
        );
      }

      // Seed 1 pending Expense Voucher
      await execute(
        `INSERT INTO expense_vouchers (voucher_number, expense_date, category, account_id, payee_name, amount, payment_method, description, status, requested_by)
         VALUES ('EXP-26-000010', ?, 'Utilities & Power', ?, 'City Power & Water Utility', 320.00, 'bank_transfer', 'Monthly clinic electricity & medical cold-chain generator fuel', 'pending', ?)`,
        [todayStr, coaByCode['5200'], accUser.id]
      );

      // Seed 1 Insurance Credit Invoice + Insurance Claim AR (submitted 38 days ago to show ageing buckets!)
      const marcus = await queryOne<{ id: number; payer_name: string | null }>("SELECT id, payer_name FROM patients WHERE mrn = 'C360-000097'");
      if (marcus) {
        const invIns = await execute(
          `INSERT INTO invoices (invoice_number, patient_id, payer_type, payer_name, subtotal, discount_amount, total_amount, paid_amount, status, notes, created_by)
           VALUES ('INV-26-000098', ?, 'insurance', ?, 140.00, 0.00, 140.00, 0.00, 'credit_billed', 'Aetna Health Plan outpatient specialist & echo claim', ?)`,
          [marcus.id, marcus.payer_name || 'Aetna Health Plan', accUser.id]
        );
        await execute(
          'INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, 1, 140.00, 140.00)',
          [invIns.insertId, 'IMG-ECHO', 'Transthoracic Echocardiogram', 'imaging']
        );
        const daysAgo38 = new Date(Date.now() - 38 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
        await execute(
          `INSERT INTO insurance_claims (claim_number, payer_name, invoice_id, patient_id, billed_amount, settled_amount, status, submitted_at, notes)
           VALUES ('CLM-26-000010', ?, ?, ?, 140.00, 0.00, 'submitted', ?, 'Awaiting Aetna batch remittance')`,
          [marcus.payer_name || 'Aetna Health Plan', invIns.insertId, marcus.id, daysAgo38]
        );
      }
    }
  }

  // Seed HR Contracts & Leave Requests
  const contractCount = await queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM staff_contracts');
  if (Number(contractCount?.cnt || 0) === 0) {
    const allUsers = await query<{ id: number; email: string; full_name: string }>(
      'SELECT id, email, full_name FROM users ORDER BY id ASC'
    );
    const expiringSoon = new Date(Date.now() + 18 * 86400000).toISOString().slice(0, 10);
    const valid2028 = '2028-06-30';
    const salaryMap: Record<string, { dept: string; base: number; allow: number; lic?: string; exp?: string }> = {
      'doc@clinic360.local': { dept: 'Internal Medicine', base: 4800, allow: 600, lic: 'MD-88412', exp: valid2028 },
      'doc2@clinic360.local': { dept: 'Pediatrics', base: 4600, allow: 600, lic: 'MD-91024', exp: expiringSoon },
      'nur@clinic360.local': { dept: 'Triage & Nursing', base: 2400, allow: 300, lic: 'RN-44109', exp: valid2028 },
      'wrd@clinic360.local': { dept: 'Inpatient Wards', base: 2550, allow: 350, lic: 'RN-55210', exp: valid2028 },
      'pha@clinic360.local': { dept: 'Dispensary Pharmacy', base: 3100, allow: 400, lic: 'RPH-2190', exp: valid2028 },
      'lab@clinic360.local': { dept: 'Clinical Laboratory', base: 2600, allow: 300, lic: 'MLS-7721', exp: valid2028 },
      'img@clinic360.local': { dept: 'Diagnostic Imaging', base: 3400, allow: 400, lic: 'RAD-3019', exp: valid2028 },
      'acc@clinic360.local': { dept: 'Finance & Ledger', base: 3200, allow: 350 },
      'hro@clinic360.local': { dept: 'Human Resources', base: 2900, allow: 300 },
      'csh@clinic360.local': { dept: 'Cashier Desk', base: 1800, allow: 200 },
      'rec@clinic360.local': { dept: 'Front Desk', base: 1650, allow: 200 },
      'sto@clinic360.local': { dept: 'Central Medical Store', base: 2100, allow: 250 },
    };
    let empSeq = 101;
    for (const u of allUsers) {
      const cfg = salaryMap[u.email] || { dept: 'Administration', base: 2200, allow: 250 };
      await execute(
        `INSERT INTO staff_contracts (user_id, employee_code, department_name, contract_type, base_salary, housing_allowance, licence_number, licence_expiry, contract_start, status)
         VALUES (?, ?, ?, 'full_time', ?, ?, ?, ?, '2025-01-01', 'active')`,
        [u.id, `EMP-${empSeq++}`, cfg.dept, cfg.base, cfg.allow, cfg.lic || null, cfg.exp || null]
      );
    }

    const nurUser = allUsers.find((u) => u.email === 'nur@clinic360.local');
    if (nurUser) {
      const nextMon = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      const nextWed = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
      await execute(
        `INSERT INTO leave_requests (user_id, leave_type, start_date, end_date, days_count, reason, status)
         VALUES (?, 'annual', ?, ?, 3, 'Annual family leave (coverage arranged with WRD)', 'pending')`,
        [nurUser.id, nextMon, nextWed]
      );
    }
  }
}

async function seedInitialData() {
  const existingBranch = await queryOne<{ id: number }>('SELECT id FROM branches LIMIT 1');
  if (existingBranch) {
    await ensureExtraPermissionsAndSeeds();
    return;
  }

  await execute('INSERT INTO branches (code, name, address, phone) VALUES (?, ?, ?, ?)', [
    'MAIN', 'Clinic360 Central Medical Center', '420 Bole Medhanialem Ave, Suite 100', '+1 (555) 234-8900'
  ]);

  const departments = [
    ['OPD', 'Outpatient Department'],
    ['TRIAGE', 'Triage & Nursing'],
    ['LAB', 'Clinical Laboratory'],
    ['IMG', 'Diagnostic Imaging'],
    ['PHA', 'Dispensary Pharmacy'],
    ['FIN', 'Cashier & Finance'],
    ['ADM', 'Administration'],
  ];
  for (const [code, name] of departments) {
    await execute('INSERT INTO departments (branch_id, code, name) VALUES (1, ?, ?)', [code, name]);
  }

  const roles = [
    ['ADM', 'System Administrator', 'Users, roles, settings, master data, backups. No clinical or financial entry by default'],
    ['MGR', 'Medical Director / Manager', 'Read all dashboards and reports, approve high-value actions'],
    ['REC', 'Receptionist', 'Patient registration, appointments, queue'],
    ['CSH', 'Cashier', 'Collect payments, issue receipts, refunds (with approval), shift closing'],
    ['NUR', 'Triage / OPD Nurse', 'Vitals, triage, OPD nursing notes, injections and dressings'],
    ['DOC', 'Doctor', 'Consultation, orders, prescriptions, admission, discharge'],
    ['WRD', 'Ward Nurse', 'Inpatient nursing care, medication administration, bed management'],
    ['LAB', 'Laboratory Technician', 'Sample handling, test results, lab stock requests'],
    ['IMG', 'Imaging Technician', 'X-ray, ultrasound and other scans, image reports'],
    ['PHA', 'Pharmacist', 'Dispense, drug stock in dispensary, drug returns'],
    ['STO', 'Store Keeper', 'Main store, receiving, issuing, stock counts, purchase requests'],
    ['ACC', 'Accountant / Finance', 'Ledgers, expenses, receivables, payables, financial reports, approvals'],
    ['HRO', 'HR Officer', 'Staff records, attendance, leave, payroll, contracts'],
    ['AUD', 'Auditor', 'Read-only access to finance, stock and the audit log'],
  ];
  const roleIdByCode: Record<string, number> = {};
  for (const [code, name, description] of roles) {
    const res = await execute('INSERT INTO roles (code, name, description) VALUES (?, ?, ?)', [code, name, description]);
    roleIdByCode[code] = res.insertId;
  }

  const permissions = [
    ['patient.create', 'Registration', 'Create patient record'],
    ['patient.read', 'Registration', 'View patient demographics'],
    ['patient.clinical.read', 'Clinical', 'View clinical allergies, blood group, and medical notes'],
    ['patient.update', 'Registration', 'Edit patient record'],
    ['patient.merge', 'Registration', 'Merge duplicate patient records'],
    ['queue.manage', 'Queue', 'Issue queue tickets and update queue status'],
    ['appointment.create', 'Appointments', 'Book appointments'],
    ['appointment.read', 'Appointments', 'View appointment schedules'],
    ['appointment.update', 'Appointments', 'Reschedule, cancel, check-in appointments'],
    ['vitals.create', 'Triage', 'Record patient vitals and triage category'],
    ['vitals.read', 'Triage', 'View patient vitals'],
    ['visit.create', 'OPD', 'Start OPD visit'],
    ['visit.read', 'OPD', 'View OPD visits and consultation notes'],
    ['visit.update', 'OPD', 'Edit open consultation notes and diagnosis'],
    ['visit.close', 'OPD', 'Close and lock visit'],
    ['visit.reopen', 'OPD', 'Approve reopening a closed visit'],
    ['order.lab.create', 'OPD', 'Order laboratory tests'],
    ['prescription.create', 'OPD', 'Prescribe medications'],
    ['lab.order.read', 'Laboratory', 'View lab worklist'],
    ['lab.sample.collect', 'Laboratory', 'Collect lab sample'],
    ['lab.result.enter', 'Laboratory', 'Enter lab test results'],
    ['lab.result.verify', 'Laboratory', 'Verify and release lab results'],
    ['pharmacy.prescription.read', 'Pharmacy', 'View prescription queue'],
    ['pharmacy.dispense', 'Pharmacy', 'Dispense paid prescriptions'],
    ['billing.invoice.create', 'Cashier', 'Create patient invoices'],
    ['billing.invoice.read', 'Cashier', 'View invoices and payment status'],
    ['billing.payment.create', 'Cashier', 'Collect payments and issue receipts'],
    ['billing.shift.manage', 'Cashier', 'Open and close own cashier shift'],
    ['billing.approval.request', 'Cashier', 'Request discount, waiver, or void/refund'],
    ['billing.approval.decide', 'Finance', 'Approve or reject discount, refund, or void requests'],
    ['finance.report.view', 'Finance', 'View financial reconciliation and revenue reports'],
    ['admin.user.manage', 'Administration', 'Create, update, and deactivate user accounts'],
    ['admin.role.manage', 'Administration', 'View and manage role permission matrix'],
    ['audit.read', 'Audit', 'View tamper-evident audit logs'],
  ];
  const permIdByCode: Record<string, number> = {};
  for (const [code, module, description] of permissions) {
    const res = await execute('INSERT INTO permissions (code, module, description) VALUES (?, ?, ?)', [code, module, description]);
    permIdByCode[code] = res.insertId;
  }

  const roleMatrix: Record<string, string[]> = {
    ADM: ['patient.read', 'patient.merge', 'admin.user.manage', 'admin.role.manage', 'audit.read'],
    MGR: [
      'patient.read', 'patient.clinical.read', 'appointment.read', 'vitals.read', 'visit.read', 'visit.reopen',
      'lab.order.read', 'pharmacy.prescription.read', 'billing.invoice.read', 'billing.approval.decide',
      'finance.report.view', 'admin.role.manage', 'audit.read'
    ],
    REC: [
      'patient.create', 'patient.read', 'patient.update', 'queue.manage',
      'appointment.create', 'appointment.read', 'appointment.update', 'visit.create'
    ],
    CSH: [
      'patient.read', 'billing.invoice.create', 'billing.invoice.read', 'billing.payment.create',
      'billing.shift.manage', 'billing.approval.request'
    ],
    NUR: [
      'patient.read', 'patient.clinical.read', 'queue.manage', 'appointment.read', 'appointment.update',
      'vitals.create', 'vitals.read', 'visit.read', 'visit.create', 'lab.order.read'
    ],
    DOC: [
      'patient.read', 'patient.clinical.read', 'patient.update', 'appointment.read', 'appointment.update',
      'vitals.create', 'vitals.read', 'visit.create', 'visit.read', 'visit.update', 'visit.close',
      'order.lab.create', 'prescription.create', 'lab.order.read', 'pharmacy.prescription.read'
    ],
    WRD: ['patient.read', 'patient.clinical.read', 'vitals.create', 'vitals.read', 'visit.read', 'lab.order.read'],
    LAB: ['patient.read', 'lab.order.read', 'lab.sample.collect', 'lab.result.enter', 'lab.result.verify', 'visit.read'],
    IMG: ['patient.read', 'visit.read'],
    PHA: ['patient.read', 'patient.clinical.read', 'pharmacy.prescription.read', 'pharmacy.dispense', 'visit.read'],
    STO: ['pharmacy.prescription.read'],
    ACC: ['billing.invoice.read', 'billing.approval.decide', 'finance.report.view'],
    HRO: [],
    AUD: [
      'patient.read', 'appointment.read', 'vitals.read', 'visit.read', 'lab.order.read',
      'pharmacy.prescription.read', 'billing.invoice.read', 'finance.report.view', 'audit.read'
    ],
  };

  for (const [roleCode, permCodes] of Object.entries(roleMatrix)) {
    const rId = roleIdByCode[roleCode];
    for (const pCode of permCodes) {
      const pId = permIdByCode[pCode];
      if (rId && pId) {
        const scope = roleCode === 'CSH' ? 'own' : 'all';
        await execute('INSERT INTO role_permissions (role_id, permission_id, scope) VALUES (?, ?, ?)', [rId, pId, scope]);
      }
    }
  }

  await execute('INSERT INTO sequences (seq_key, prefix, current_value) VALUES (?, ?, ?)', ['MRN', 'C360-', 100]);
  await execute('INSERT INTO sequences (seq_key, prefix, current_value) VALUES (?, ?, ?)', ['VISIT', 'VIS-26-', 100]);
  await execute('INSERT INTO sequences (seq_key, prefix, current_value) VALUES (?, ?, ?)', ['INV', 'INV-26-', 100]);
  await execute('INSERT INTO sequences (seq_key, prefix, current_value) VALUES (?, ?, ?)', ['RCP', 'RCP-26-', 100]);
  await execute('INSERT INTO sequences (seq_key, prefix, current_value) VALUES (?, ?, ?)', ['TICKET', 'Q-', 10]);
  await execute('INSERT INTO sequences (seq_key, prefix, current_value) VALUES (?, ?, ?)', ['ADM', 'ADM-26-', 10]);

  const allowDemoSeed = process.env.NODE_ENV !== 'production' || process.env.SEED_DEMO === 'true';
  const demoPasswordHash = await bcrypt.hash(allowDemoSeed ? 'Clinic360!' : crypto.randomBytes(24).toString('hex'), 10);

  const demoUsers: Array<{ name: string; email: string; role: string; specialty?: string }> = allowDemoSeed
    ? [
        { name: 'Dr. Elena Vance', email: 'doc@clinic360.local', role: 'DOC', specialty: 'Internal Medicine' },
        { name: 'Dr. Samuel Bekele', email: 'doc2@clinic360.local', role: 'DOC', specialty: 'Pediatrics & Family Care' },
        { name: 'Maya Lin', email: 'rec@clinic360.local', role: 'REC' },
        { name: 'Clara Ortiz, RN', email: 'nur@clinic360.local', role: 'NUR' },
        { name: 'David Kim', email: 'csh@clinic360.local', role: 'CSH' },
        { name: 'Tariq Hassan', email: 'lab@clinic360.local', role: 'LAB' },
        { name: 'Nadia Patel, PharmD', email: 'pha@clinic360.local', role: 'PHA' },
        { name: 'Arthur Pendelton', email: 'acc@clinic360.local', role: 'ACC' },
        { name: 'Dr. Marcus Thorne', email: 'mgr@clinic360.local', role: 'MGR', specialty: 'Medical Director' },
        { name: 'Hannah Brooks', email: 'adm@clinic360.local', role: 'ADM' },
        { name: 'Victor Alvarez', email: 'aud@clinic360.local', role: 'AUD' },
      ]
    : [
        {
          name: process.env.BOOTSTRAP_ADMIN_NAME || 'System Administrator',
          email: (process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@clinic360.local').toLowerCase(),
          role: 'ADM',
        },
      ];

  const userIds: Record<string, number> = {};
  for (const u of demoUsers) {
    const res = await execute(
      'INSERT INTO users (branch_id, full_name, email, password_hash, specialty, must_change_password) VALUES (1, ?, ?, ?, ?, ?)',
      [u.name, u.email, demoPasswordHash, u.specialty ?? null, allowDemoSeed ? 0 : 1]
    );
    userIds[u.email] = res.insertId;
    await execute('INSERT INTO user_roles (user_id, role_id, branch_id) VALUES (?, ?, 1)', [
      res.insertId,
      roleIdByCode[u.role],
    ]);
  }
  if (!allowDemoSeed) {
    await ensureExtraPermissionsAndSeeds();
    return;
  }

  const services = [
    ['REG-CARD', 'New Patient Registration Card', 'registration', 15.00],
    ['OPD-CONS', 'General Outpatient Consultation', 'consultation', 45.00],
    ['OPD-SPEC', 'Specialist Consultation', 'consultation', 75.00],
    ['OPD-FU', 'Follow-up Consultation', 'consultation', 25.00],
    ['NUR-INJ', 'Intramuscular Injection & Dressing', 'procedure', 18.00],
    ['NUR-NEB', 'Nebulization Therapy', 'procedure', 22.00],
    ['IMG-XRAY', 'Chest X-Ray (PA & Lateral)', 'imaging', 65.00],
    ['IMG-US', 'Abdominal Ultrasound', 'imaging', 90.00],
  ];
  for (const [code, name, cat, price] of services) {
    await execute('INSERT INTO services (code, name, category, unit_price) VALUES (?, ?, ?, ?)', [code, name, cat, price]);
  }

  const labTests = [
    ['LAB-CBC', 'Complete Blood Count (CBC)', 'Whole Blood (EDTA)', '10^9/L', '4.0 - 11.0 WBC', 32.00, 45],
    ['LAB-BMP', 'Basic Metabolic Panel (BMP)', 'Serum', 'mmol/L', '3.9 - 5.5 Glucose', 44.00, 60],
    ['LAB-HBA1C', 'Hemoglobin A1c', 'Whole Blood', '%', '4.0 - 5.6', 38.00, 90],
    ['LAB-UA', 'Urinalysis Complete', 'Urine', 'Qualitative', 'Negative Nitrite/Leuk', 18.00, 30],
    ['LAB-LFT', 'Liver Function Panel (LFT)', 'Serum', 'U/L', '7 - 56 ALT', 52.00, 75],
  ];
  for (const [code, name, sample, unit, ref, price, tat] of labTests) {
    await execute(
      'INSERT INTO lab_tests (code, name, sample_type, unit, reference_range, price, turnaround_mins) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [code, name, sample, unit, ref, price, tat]
    );
  }

  const medicines = [
    ['MED-AMOX', 'Amoxicillin', '500mg', 'Capsule', 12.50, 240, 40, 'BCH-2604A', '2027-08-30'],
    ['MED-PARA', 'Paracetamol (Acetaminophen)', '500mg', 'Tablet', 4.50, 520, 100, 'BCH-2602C', '2027-11-15'],
    ['MED-METF', 'Metformin HCl', '850mg', 'Tablet', 16.00, 185, 50, 'BCH-2601K', '2027-05-20'],
    ['MED-LISI', 'Lisinopril', '10mg', 'Tablet', 19.00, 140, 30, 'BCH-2603M', '2027-09-12'],
    ['MED-AZIT', 'Azithromycin', '250mg', 'Tablet', 22.00, 34, 40, 'BCH-2511R', '2027-01-30'],
    ['MED-SALB', 'Salbutamol Inhaler', '100mcg', 'Inhaler', 28.00, 48, 15, 'BCH-2605P', '2028-02-28'],
  ];
  for (const [code, gen, str, form, price, stock, reorder, batch, exp] of medicines) {
    await execute(
      'INSERT INTO medicines (code, generic_name, strength, form, unit_price, stock_qty, reorder_level, batch_number, expiry_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [code, gen, str, form, price, stock, reorder, batch, exp]
    );
  }

  const patients = [
    ['C360-000096', 'Amira', 'Kassahun', 'Female', '1989-04-12', '+1-555-0142', 'amira.k@example.com', '142 Oakwood Ln', 'Dawit Kassahun', '+1-555-0199', 'O+', 'Penicillin (rash)', 'self-pay', null, null],
    ['C360-000097', 'Marcus', 'Sterling', 'Male', '1974-09-28', '+1-555-0188', 'm.sterling@example.com', '88 Maple Terrace', 'Claire Sterling', '+1-555-0189', 'A+', 'None known', 'insurance', 'Aetna Health Plan', 'AET-884920'],
    ['C360-000098', 'Sofia', 'Mendoza', 'Female', '1995-02-05', '+1-555-0163', 'sofia.m@example.com', '310 Pine Street', 'Carlos Mendoza', '+1-555-0164', 'B+', 'Sulfa drugs', 'self-pay', null, null],
    ['C360-000099', 'Liam', 'OConnor', 'Male', '2018-11-14', '+1-555-0171', null, '54 Cedar Court', 'Fiona OConnor', '+1-555-0172', 'O-', 'None known', 'credit', 'Global Care NGO', 'GC-2026-14'],
    ['C360-000100', 'Evelyn', 'Chen', 'Female', '1963-07-19', '+1-555-0155', 'echen@example.com', '719 Birch Blvd', 'Alan Chen', '+1-555-0156', 'AB+', 'Aspirin (bronchospasm)', 'insurance', 'BlueCross Shield', 'BC-992104'],
  ];
  const patientIds: number[] = [];
  for (const p of patients) {
    const res = await execute(
      `INSERT INTO patients (mrn, first_name, last_name, sex, date_of_birth, phone, email, address, next_of_kin_name, next_of_kin_phone, blood_group, allergies, patient_type, payer_name, insurance_number, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...p, userIds['rec@clinic360.local']]
    );
    patientIds.push(res.insertId);
  }

  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const appts = [
    [patientIds[0], userIds['doc@clinic360.local'], today, '09:00', '09:30', 'consultation', 'Persistent cough and low-grade fever', 'checked_in'],
    [patientIds[1], userIds['doc@clinic360.local'], today, '09:30', '10:00', 'follow-up', 'Hypertension & HbA1c lab review', 'checked_in'],
    [patientIds[2], userIds['doc@clinic360.local'], today, '10:30', '11:00', 'consultation', 'Acute migraine episodes', 'scheduled'],
    [patientIds[3], userIds['doc2@clinic360.local'], today, '11:00', '11:30', 'checkup', 'Pediatric annual wellness & asthma check', 'scheduled'],
    [patientIds[4], userIds['doc@clinic360.local'], tomorrow, '09:00', '09:30', 'follow-up', 'Post-discharge cardiology follow-up', 'scheduled'],
  ];
  for (const a of appts) {
    await execute(
      `INSERT INTO appointments (patient_id, doctor_id, appointment_date, start_time, end_time, visit_type, reason, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...a, userIds['rec@clinic360.local']]
    );
  }

  const shiftRes = await execute(
    'INSERT INTO cashier_shifts (cashier_id, opening_float, expected_cash, status) VALUES (?, 200.00, 245.00, ?)',
    [userIds['csh@clinic360.local'], 'open']
  );

  const v1 = await execute(
    `INSERT INTO visits (visit_number, patient_id, doctor_id, visit_type, specialty, workflow_stage, triage_priority, chief_complaint, history_notes, exam_notes, diagnosis_code, diagnosis_text, treatment_plan, status, created_by)
     VALUES (?, ?, ?, 'scheduled', 'Internal Medicine', 'awaiting_diagnostics', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'VIS-26-000099', patientIds[0], userIds['doc@clinic360.local'], 'urgent',
      'Productive cough x 4 days, mild dyspnea',
      'Non-smoker, fever 38.4C at home. Allergic to Penicillin.',
      'Scattered rhonchi right lower zone, alert and oriented.',
      'J20.9', 'Acute Bronchitis', 'Order CBC, Chest X-Ray, dispense Azithromycin (avoid beta-lactams due to Penicillin allergy).',
      'in_consultation', userIds['nur@clinic360.local']
    ]
  );

  await execute(
    `INSERT INTO vitals (visit_id, patient_id, bp_systolic, bp_diastolic, temperature, pulse, respiratory_rate, spo2, weight_kg, height_cm, bmi, early_warning_flag, notes, recorded_by)
     VALUES (?, ?, 128, 82, 38.6, 98, 22, 91, 64.0, 165.0, 23.5, 1, 'SpO2 91% on room air - flagged for urgent review', ?)`,
    [v1.insertId, patientIds[0], userIds['nur@clinic360.local']]
  );

  const v2 = await execute(
    `INSERT INTO visits (visit_number, patient_id, doctor_id, visit_type, specialty, workflow_stage, triage_priority, chief_complaint, status, created_by)
     VALUES (?, ?, ?, 'scheduled', 'Internal Medicine', 'ready_for_doctor', ?, ?, ?, ?)`,
    ['VIS-26-000100', patientIds[1], userIds['doc@clinic360.local'], 'routine', 'BP check and metabolic lab follow-up', 'triage', userIds['rec@clinic360.local']]
  );

  await execute(
    `INSERT INTO vitals (visit_id, patient_id, bp_systolic, bp_diastolic, temperature, pulse, respiratory_rate, spo2, weight_kg, height_cm, bmi, blood_glucose, early_warning_flag, recorded_by)
     VALUES (?, ?, 138, 88, 36.7, 74, 16, 98, 84.5, 178.0, 26.7, 118.0, 0, ?)`,
    [v2.insertId, patientIds[1], userIds['nur@clinic360.local']]
  );

  await execute(
    'INSERT INTO queue_tickets (ticket_number, department, patient_id, visit_id, priority, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['Q-000008', 'OPD', patientIds[0], v1.insertId, 'urgent', 'in_service', userIds['rec@clinic360.local']]
  );
  await execute(
    'INSERT INTO queue_tickets (ticket_number, department, patient_id, visit_id, priority, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['Q-000009', 'OPD', patientIds[1], v2.insertId, 'routine', 'waiting', userIds['rec@clinic360.local']]
  );
  await execute(
    'INSERT INTO queue_tickets (ticket_number, department, patient_id, priority, status, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    ['Q-000010', 'LAB', patientIds[0], 'urgent', 'waiting', userIds['rec@clinic360.local']]
  );

  const inv1 = await execute(
    `INSERT INTO invoices (invoice_number, patient_id, visit_id, payer_type, subtotal, discount_amount, total_amount, paid_amount, status, created_by)
     VALUES (?, ?, ?, 'self-pay', 45.00, 0.00, 45.00, 45.00, 'paid', ?)`,
    ['INV-26-000099', patientIds[0], v1.insertId, userIds['csh@clinic360.local']]
  );
  await execute('UPDATE visits SET consultation_invoice_id = ? WHERE id = ?', [inv1.insertId, v1.insertId]);
  await execute(
    'INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, 1, 45.00, 45.00)',
    [inv1.insertId, 'OPD-CONS', 'General Outpatient Consultation', 'consultation']
  );

  const pay1 = await execute(
    `INSERT INTO payments (invoice_id, patient_id, shift_id, amount, payment_method, reference_number, created_by)
     VALUES (?, ?, ?, 45.00, 'cash', 'CSH-9901', ?)`,
    [inv1.insertId, patientIds[0], shiftRes.insertId, userIds['csh@clinic360.local']]
  );
  await execute(
    `INSERT INTO receipts (receipt_number, payment_id, invoice_id, patient_id, amount, payment_method, issued_by)
     VALUES (?, ?, ?, ?, 45.00, 'cash', ?)`,
    ['RCP-26-000099', pay1.insertId, inv1.insertId, patientIds[0], userIds['csh@clinic360.local']]
  );

  const inv2 = await execute(
    `INSERT INTO invoices (invoice_number, patient_id, visit_id, payer_type, subtotal, discount_amount, total_amount, paid_amount, status, created_by)
     VALUES (?, ?, ?, 'self-pay', 54.00, 0.00, 54.00, 0.00, 'unpaid', ?)`,
    ['INV-26-000100', patientIds[0], v1.insertId, userIds['doc@clinic360.local']]
  );
  await execute(
    'INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, 1, 32.00, 32.00)',
    [inv2.insertId, 'LAB-CBC', 'Complete Blood Count (CBC)', 'lab']
  );
  await execute(
    'INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, 1, 22.00, 22.00)',
    [inv2.insertId, 'MED-AZIT', 'Azithromycin 250mg Tablet', 'pharmacy']
  );

  const cbcRow = await queryOne<{ id: number }>('SELECT id FROM lab_tests WHERE code = ?', ['LAB-CBC']);
  const azitRow = await queryOne<{ id: number }>('SELECT id FROM medicines WHERE code = ?', ['MED-AZIT']);
  if (cbcRow) {
    await execute(
      'INSERT INTO lab_orders (visit_id, patient_id, test_id, invoice_id, ordered_by, status) VALUES (?, ?, ?, ?, ?, ?)',
      [v1.insertId, patientIds[0], cbcRow.id, inv2.insertId, userIds['doc@clinic360.local'], 'ordered']
    );
  }
  if (azitRow) {
    const rx = await execute(
      'INSERT INTO prescriptions (visit_id, patient_id, doctor_id, invoice_id, status, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [v1.insertId, patientIds[0], userIds['doc@clinic360.local'], inv2.insertId, 'pending', 'Patient allergic to Penicillin; macrolide selected']
    );
    await execute(
      'INSERT INTO prescription_items (prescription_id, medicine_id, dosage, frequency, duration_days, quantity, instructions) VALUES (?, ?, ?, ?, 5, 1, ?)',
      [rx.insertId, azitRow.id, '500mg day 1 then 250mg', 'Once daily', 'Take with or without food']
    );
  }

  await execute(
    `INSERT INTO approval_requests (request_type, entity_type, entity_id, requested_amount, reason, status, requested_by)
     VALUES ('discount', 'invoice', ?, 10.00, 'Senior citizen courtesy waiver requested at desk', 'pending', ?)`,
    [inv2.insertId, userIds['csh@clinic360.local']]
  );

  const genesisOccurredAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const genesisAfterJson = JSON.stringify({ roles: 14, users: demoUsers.length });
  const genesisPayload = JSON.stringify({
    occurredAt: genesisOccurredAt,
    userId: userIds['adm@clinic360.local'],
    userName: 'Hannah Brooks',
    roleAtTime: 'ADM',
    action: 'system.bootstrap',
    entityType: 'system',
    entityId: 'clinic360',
    patientId: null,
    beforeJson: null,
    afterJson: genesisAfterJson,
    reason: 'Initial Clinic360 database seed',
    ipAddress: '127.0.0.1',
    userAgent: '',
    branchId: 1,
    prevHash: 'GENESIS',
  });
  const rowHash = crypto.createHash('sha256').update(genesisPayload).digest('hex');
  await execute(
    `INSERT INTO audit_logs (occurred_at, user_id, user_name, role_at_time, action, entity_type, entity_id, after_json, reason, ip_address, user_agent, branch_id, prev_hash, row_hash)
     VALUES (?, ?, 'Hannah Brooks', 'ADM', 'system.bootstrap', 'system', 'clinic360', ?, 'Initial Clinic360 database seed', '127.0.0.1', '', 1, 'GENESIS', ?)`,
    [genesisOccurredAt, userIds['adm@clinic360.local'], genesisAfterJson, rowHash]
  );

  await ensureExtraPermissionsAndSeeds();
}

async function initMysqlSchema(pool: mysql.Pool) {
  const schemaPath = path.resolve(process.cwd(), 'server', 'schema.mysql.sql');
  if (!fs.existsSync(schemaPath)) return;
  const raw = fs.readFileSync(schemaPath, 'utf8');
  const cleaned = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const statements = cleaned
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const [rows] = (await pool.query("SHOW TABLES LIKE 'branches'")) as unknown as [Array<Record<string, unknown>>, unknown];
  if (rows.length === 0) {
    for (const stmt of statements) {
      await pool.query(stmt);
    }
    return;
  }
  // Ensure any new tables exist on pre-existing MySQL schemas
  for (const stmt of statements) {
    if (/^CREATE TABLE IF NOT EXISTS/i.test(stmt)) {
      await pool.query(stmt);
    }
  }
}

export function getDbConfigSummary() {
  return {
    dialect: activeDialect,
    dbClientMode: process.env.DB_CLIENT || 'auto',
    mysqlConfigured: Boolean(
      process.env.MYSQL_URL ||
        (process.env.MYSQL_HOST && process.env.MYSQL_USER && process.env.MYSQL_DATABASE && process.env.MYSQL_PASSWORD !== 'change_me')
    ),
    mysqlHost: process.env.MYSQL_HOST || '127.0.0.1',
    mysqlPort: Number(process.env.MYSQL_PORT || 3306),
    mysqlDatabase: process.env.MYSQL_DATABASE || 'clinic360',
    sslEnabled: process.env.MYSQL_SSL === 'true',
  };
}

export async function initDatabase(): Promise<{ dialect: DbDialect }> {
  const mode = (process.env.DB_CLIENT || 'auto').toLowerCase();
  const mysqlUrl = process.env.MYSQL_URL?.trim();
  const host = process.env.MYSQL_HOST;
  const user = process.env.MYSQL_USER;
  const password = process.env.MYSQL_PASSWORD;
  const database = process.env.MYSQL_DATABASE;
  const port = Number(process.env.MYSQL_PORT || 3306);
  const useSsl = process.env.MYSQL_SSL === 'true';

  const shouldTryMysql =
    mode !== 'sqlite' &&
    (Boolean(mysqlUrl) ||
      (Boolean(host && user && database) && (mode === 'mysql' || password !== 'change_me')));

  if (shouldTryMysql) {
    try {
      mysqlPool = mysqlUrl
        ? mysql.createPool({
            uri: mysqlUrl,
            waitForConnections: true,
            connectionLimit: 10,
            dateStrings: true,
            ssl: useSsl ? { rejectUnauthorized: false } : undefined,
          })
        : mysql.createPool({
            host,
            port,
            user,
            password,
            database,
            waitForConnections: true,
            connectionLimit: 10,
            dateStrings: true,
            ssl: useSsl ? { rejectUnauthorized: false } : undefined,
          });
      await mysqlPool.query('SELECT 1');
      activeDialect = 'mysql';
      await initMysqlSchema(mysqlPool);
      console.log(`[Clinic360] Connected to MySQL 8 (${mysqlUrl ? 'MYSQL_URL' : `${host}:${port}/${database}`})`);
      await seedInitialData();
      return { dialect: 'mysql' };
    } catch (err) {
      if (mode === 'mysql') {
        throw err;
      }
      console.warn('[Clinic360] MySQL connection unavailable, falling back to embedded SQLite:', (err as Error).message);
      mysqlPool = null;
    }
  }

  const dbPath = path.resolve(process.cwd(), 'clinic360.db');
  sqliteDb = new Database(dbPath);
  activeDialect = 'sqlite';
  await initSqliteSchema(sqliteDb);
  await seedInitialData();
  console.log(`[Clinic360] Database ready (${activeDialect} at ${dbPath})`);
  return { dialect: 'sqlite' };
}
