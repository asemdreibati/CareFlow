/**
 * Demo data. Run with `pnpm db:seed` (idempotent: skips if the demo clinic exists).
 * Logins (password for all: Password123):
 *   owner@demo.clinic (OWNER), admin@demo.clinic (ADMIN), dr.salem@demo.clinic (DOCTOR),
 *   dr.nour@demo.clinic (DOCTOR), reception@demo.clinic (RECEPTIONIST), finance@demo.clinic (ACCOUNTANT)
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return tx.clinic.findUnique({ where: { slug: 'demo' } });
  });
  if (existing) {
    console.log('Demo clinic already exists - nothing to do.');
    return;
  }

  const passwordHash = await bcrypt.hash('Password123', 12);

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;

    const clinic = await tx.clinic.create({
      data: { name: 'Demo Family Clinic', slug: 'demo', timezone: 'Asia/Riyadh', currency: 'SAR', phone: '+966 11 000 0000', email: 'hello@demo.clinic', address: 'King Fahd Rd, Riyadh' },
    });
    const clinicId = clinic.id;

    const mkUser = (email: string, firstName: string, lastName: string) =>
      tx.user.create({ data: { email, passwordHash, firstName, lastName } });

    const owner = await mkUser('owner@demo.clinic', 'Omar', 'Owner');
    const admin = await mkUser('admin@demo.clinic', 'Aisha', 'Admin');
    const drSalem = await mkUser('dr.salem@demo.clinic', 'Salem', 'Al-Harbi');
    const drNour = await mkUser('dr.nour@demo.clinic', 'Nour', 'Khalil');
    const reception = await mkUser('reception@demo.clinic', 'Rana', 'Reception');
    const finance = await mkUser('finance@demo.clinic', 'Faisal', 'Finance');

    await tx.clinicMembership.createMany({
      data: [
        { clinicId, userId: owner.id, role: 'OWNER' },
        { clinicId, userId: admin.id, role: 'ADMIN' },
        { clinicId, userId: drSalem.id, role: 'DOCTOR' },
        { clinicId, userId: drNour.id, role: 'DOCTOR' },
        { clinicId, userId: reception.id, role: 'RECEPTIONIST' },
        { clinicId, userId: finance.id, role: 'ACCOUNTANT' },
      ],
    });

    const d1 = await tx.doctor.create({ data: { clinicId, userId: drSalem.id, firstName: 'Salem', lastName: 'Al-Harbi', title: 'Dr.', specialty: 'General Practice', licenseNumber: 'GP-10234', color: '#2563eb' } });
    const d2 = await tx.doctor.create({ data: { clinicId, userId: drNour.id, firstName: 'Nour', lastName: 'Khalil', title: 'Dr.', specialty: 'Pediatrics', licenseNumber: 'PD-55821', color: '#16a34a' } });
    const d3 = await tx.doctor.create({ data: { clinicId, firstName: 'Lina', lastName: 'Mansour', title: 'Dr.', specialty: 'Dermatology', licenseNumber: 'DM-77120', color: '#db2777' } });

    const weekdays = [0, 1, 2, 3, 4]; // Sun-Thu
    await tx.doctorAvailability.createMany({
      data: [
        ...weekdays.flatMap((w) => [
          { clinicId, doctorId: d1.id, weekday: w, startTime: '09:00', endTime: '13:00', slotMinutes: 30 },
          { clinicId, doctorId: d1.id, weekday: w, startTime: '16:00', endTime: '20:00', slotMinutes: 30 },
        ]),
        ...weekdays.map((w) => ({ clinicId, doctorId: d2.id, weekday: w, startTime: '10:00', endTime: '18:00', slotMinutes: 20 })),
        ...[1, 3].map((w) => ({ clinicId, doctorId: d3.id, weekday: w, startTime: '14:00', endTime: '19:00', slotMinutes: 45 })),
      ],
    });

    await tx.service.createMany({
      data: [
        { clinicId, code: 'CONS', name: 'General consultation', price: 150, durationMinutes: 30 },
        { clinicId, code: 'FUP', name: 'Follow-up visit', price: 80, durationMinutes: 20 },
        { clinicId, code: 'PED', name: 'Pediatric consultation', price: 180, durationMinutes: 20 },
        { clinicId, code: 'DERM', name: 'Dermatology consultation', price: 250, durationMinutes: 45 },
        { clinicId, code: 'LAB-CBC', name: 'Complete blood count', price: 60, durationMinutes: 10 },
      ],
    });

    const patientsData = [
      ['Sami', 'Haddad', '1985-04-12', 'MALE', '0501111111'],
      ['Layla', 'Nassar', '1992-09-30', 'FEMALE', '0502222222'],
      ['Yousef', 'Qasim', '2016-01-05', 'MALE', '0503333333'],
      ['Maha', 'Saleh', '1978-11-21', 'FEMALE', '0504444444'],
      ['Khalid', 'Omran', '1960-06-14', 'MALE', '0505555555'],
      ['Dana', 'Farah', '2019-03-03', 'FEMALE', '0506666666'],
      ['Tariq', 'Ayoub', '1999-12-25', 'MALE', '0507777777'],
      ['Huda', 'Rashid', '1988-07-07', 'FEMALE', '0508888888'],
    ] as const;
    const patients = [];
    let i = 1;
    for (const [firstName, lastName, dob, gender, phone] of patientsData) {
      patients.push(
        await tx.patient.create({
          data: { clinicId, mrn: `MRN-${String(i++).padStart(6, '0')}`, firstName, lastName, dateOfBirth: new Date(dob), gender, phone, email: `${firstName.toLowerCase()}@example.com` },
        }),
      );
    }
    await tx.allergy.createMany({
      data: [
        { clinicId, patientId: patients[0].id, substance: 'Penicillin', reaction: 'Rash', severity: 'MODERATE' },
        { clinicId, patientId: patients[4].id, substance: 'Aspirin', reaction: 'Bronchospasm', severity: 'SEVERE' },
      ],
    });

    // Appointments around "today" (kept to working hours so availability checks pass)
    const today = new Date();
    const at = (dayOffset: number, h: number, m = 0) => {
      const d = new Date(today);
      d.setDate(d.getDate() + dayOffset);
      d.setHours(h, m, 0, 0);
      return d;
    };
    const mins = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);
    const appts = [
      { doctorId: d1.id, patientId: patients[0].id, s: at(0, 9, 0), dur: 30, status: 'COMPLETED', type: 'CONSULTATION' },
      { doctorId: d1.id, patientId: patients[1].id, s: at(0, 9, 30), dur: 30, status: 'CHECKED_IN', type: 'FOLLOW_UP' },
      { doctorId: d1.id, patientId: patients[3].id, s: at(0, 10, 0), dur: 30, status: 'SCHEDULED', type: 'CONSULTATION' },
      { doctorId: d2.id, patientId: patients[2].id, s: at(0, 10, 0), dur: 20, status: 'CONFIRMED', type: 'CHECKUP' },
      { doctorId: d2.id, patientId: patients[5].id, s: at(0, 10, 20), dur: 20, status: 'SCHEDULED', type: 'CONSULTATION' },
      { doctorId: d1.id, patientId: patients[4].id, s: at(1, 16, 0), dur: 30, status: 'SCHEDULED', type: 'FOLLOW_UP' },
      { doctorId: d2.id, patientId: patients[6].id, s: at(1, 11, 0), dur: 20, status: 'SCHEDULED', type: 'CONSULTATION' },
      { doctorId: d1.id, patientId: patients[7].id, s: at(-1, 9, 0), dur: 30, status: 'NO_SHOW', type: 'CONSULTATION' },
      { doctorId: d1.id, patientId: patients[2].id, s: at(-2, 16, 30), dur: 30, status: 'COMPLETED', type: 'CONSULTATION' },
    ] as const;
    for (const a of appts) {
      await tx.appointment.create({
        data: { clinicId, doctorId: a.doctorId, patientId: a.patientId, startsAt: a.s, endsAt: mins(a.s, a.dur), status: a.status, type: a.type, createdById: reception.id },
      });
    }

    // One signed encounter for the completed visit two days ago
    const enc = await tx.encounter.create({
      data: {
        clinicId, patientId: patients[2].id, doctorId: d1.id, occurredAt: at(-2, 16, 30), status: 'SIGNED', signedAt: at(-2, 17, 0),
        chiefComplaint: 'Fever and sore throat for 2 days',
        subjective: 'Parent reports fever up to 38.9C, sore throat, reduced appetite. No vomiting.',
        objective: 'Temp 38.4C, HR 110, pharyngeal erythema, no exudate, lungs clear.',
        assessment: 'Viral pharyngitis.',
        plan: 'Supportive care, paracetamol 15mg/kg q6h PRN, fluids. Return if symptoms persist > 5 days.',
        vitals: { temperatureC: 38.4, heartRate: 110, weightKg: 22 },
      },
    });
    await tx.diagnosis.create({ data: { clinicId, encounterId: enc.id, code: 'J02.9', description: 'Acute pharyngitis, unspecified', isPrimary: true } });
    await tx.prescription.create({ data: { clinicId, encounterId: enc.id, patientId: patients[2].id, doctorId: d1.id, medication: 'Paracetamol syrup 120mg/5ml', dosage: '15 mg/kg', frequency: 'Every 6 hours as needed', durationDays: 5 } });

    const inv = await tx.invoice.create({
      data: { clinicId, patientId: patients[2].id, encounterId: enc.id, number: `INV-${today.getFullYear()}-000001`, status: 'PARTIALLY_PAID', currency: 'SAR', subtotal: 150, total: 150, amountPaid: 50, issuedAt: at(-2, 17, 5), createdById: reception.id },
    });
    await tx.invoiceItem.create({ data: { clinicId, invoiceId: inv.id, description: 'General consultation', quantity: 1, unitPrice: 150, total: 150 } });
    await tx.payment.create({ data: { clinicId, invoiceId: inv.id, amount: 50, method: 'CASH', receivedById: reception.id } });

    console.log(`Seeded clinic "${clinic.name}" (${clinicId}) with ${patients.length} patients, 3 doctors, ${appts.length} appointments.`);
  });
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
