const router = require('express').Router();
const db = require('../db/schema');
const auth = require('../middleware/auth');
const validate = require('../middleware/validate');
const { sendDisputeResolvedEmail } = require('../utils/mailer');

// POST /api/disputes — buyer files a dispute on a paid order
router.post('/', auth, validate.dispute, async (req, res) => {
  if (req.user.role !== 'buyer')
    return res.status(403).json({ error: 'Only buyers can file disputes' });

  const order_id = parseInt(req.body.order_id, 10);
  const { reason } = req.body;

  const { rows: orderRows } = await db.query(
    'SELECT * FROM orders WHERE id = $1 AND buyer_id = $2',
    [order_id, req.user.id]
  );
  const order = orderRows[0];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'paid')
    return res.status(400).json({ error: 'Disputes can only be filed on paid orders' });

  const { rows: existingRows } = await db.query(
    'SELECT id FROM disputes WHERE order_id = $1',
    [order_id]
  );
  if (existingRows[0]) return res.status(409).json({ error: 'A dispute already exists for this order' });

  const { rows } = await db.query(
    'INSERT INTO disputes (order_id, buyer_id, reason) VALUES ($1, $2, $3) RETURNING id',
    [order_id, req.user.id, reason.trim()]
  );

  res.status(201).json({ id: rows[0].id, order_id, status: 'open', message: 'Dispute filed' });
});

// GET /api/disputes — admin lists all disputes
router.get('/', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });

  const { rows } = await db.query(`
    SELECT d.*, u.name as buyer_name, u.email as buyer_email,
           o.total_price, o.quantity, p.name as product_name
    FROM disputes d
    JOIN users u ON d.buyer_id = u.id
    JOIN orders o ON d.order_id = o.id
    JOIN products p ON o.product_id = p.id
    ORDER BY d.created_at DESC
  `);
  res.json(rows);
});

// PATCH /api/disputes/:id — admin resolves a dispute
router.patch('/:id', auth, validate.resolveDispute, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });

  const { rows: disputeRows } = await db.query('SELECT * FROM disputes WHERE id = $1', [req.params.id]);
  const dispute = disputeRows[0];
  if (!dispute) return res.status(404).json({ error: 'Dispute not found' });

  const { status, resolution } = req.body;

  const transitions = { open: ['under_review'], under_review: ['resolved'], resolved: [] };
  if (!transitions[dispute.status].includes(status))
    return res.status(400).json({ error: `Cannot transition from '${dispute.status}' to '${status}'` });

  if (status === 'resolved' && (!resolution || !resolution.trim()))
    return res.status(400).json({ error: 'A resolution note is required when resolving a dispute' });

  await db.query(
    'UPDATE disputes SET status = $1, resolution = $2 WHERE id = $3',
    [status, resolution ? resolution.trim() : dispute.resolution, dispute.id]
  );

  if (status === 'resolved') {
    const { rows: buyerRows } = await db.query('SELECT * FROM users WHERE id = $1', [dispute.buyer_id]);
    const { rows: orderRows } = await db.query('SELECT * FROM orders WHERE id = $1', [dispute.order_id]);
    const { rows: productRows } = await db.query('SELECT * FROM products WHERE id = $1', [orderRows[0].product_id]);

    sendDisputeResolvedEmail({
      dispute: { ...dispute, resolution: resolution.trim() },
      order: orderRows[0],
      product: productRows[0],
      buyer: buyerRows[0],
    }).catch((e) => console.error('Dispute email failed:', e.message));
  }

  res.json({ id: dispute.id, status, message: 'Dispute updated' });
});

module.exports = router;
