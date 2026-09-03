TRUNCATE audit_events, policy_decisions, task_nodes, agent_tasks, authorization_challenges,
  subscriptions, cards, bank_transactions, ledger_entries, ledger_transactions, transfers,
  beneficiaries, accounts, customers RESTART IDENTITY CASCADE;

INSERT INTO customers (id, display_name, phone, risk_profile) VALUES
('11111111-1111-4111-8111-111111111111', '李明', '13800000001', 'BALANCED');

INSERT INTO accounts (id, customer_id, name, account_type, masked_no, available_balance_minor) VALUES
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '11111111-1111-4111-8111-111111111111', '工资卡', 'CHECKING', '•• 8821', 1852000),
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '11111111-1111-4111-8111-111111111111', '安心储蓄', 'SAVINGS', '•• 1906', 4280000),
('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', NULL, '外部清算账户 A', 'SETTLEMENT', 'SETTLE-A', 1000000000),
('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', NULL, '外部清算账户 B', 'SETTLEMENT', 'SETTLE-B', 1000000000);

INSERT INTO beneficiaries (id, customer_id, name, phone, bank_name, masked_account, settlement_account_id, trusted) VALUES
('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', '11111111-1111-4111-8111-111111111111', '张伟', '13900001111', '建设银行', '•• 6217', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', true),
('cccccccc-cccc-4ccc-8ccc-ccccccccccc2', '11111111-1111-4111-8111-111111111111', '王芳', '13600002222', '招商银行', '•• 9032', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', true);

INSERT INTO cards (id, customer_id, account_id, card_name, masked_no, card_type, overseas_enabled, daily_limit_minor) VALUES
('dddddddd-dddd-4ddd-8ddd-ddddddddddd1', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '日常借记卡', '•• 8821', 'DEBIT', false, 500000),
('dddddddd-dddd-4ddd-8ddd-ddddddddddd2', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '旅行虚拟卡', '•• 7403', 'VIRTUAL', true, 300000);

INSERT INTO subscriptions (id, customer_id, card_id, merchant_name, amount_minor, billing_cycle, next_charge_at, cancellation_channel) VALUES
('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', '11111111-1111-4111-8111-111111111111', 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1', '云听音乐', 1800, 'MONTHLY', now() + interval '5 days', 'MERCHANT'),
('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2', '11111111-1111-4111-8111-111111111111', 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1', '星幕视频', 2500, 'MONTHLY', now() + interval '11 days', 'BANK_BLOCK'),
('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3', '11111111-1111-4111-8111-111111111111', 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2', 'Nimbus 云盘', 16800, 'YEARLY', now() + interval '19 days', 'MERCHANT');

INSERT INTO bank_transactions (account_id, merchant_name, category, amount_minor, occurred_at, is_anomaly) VALUES
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '薪资入账', '收入', 1850000, now() - interval '3 days', false),
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '青禾咖啡', '餐饮', -3600, now() - interval '1 day', false),
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '小象外卖', '餐饮', -4280, now() - interval '2 days', false),
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '城市地铁', '交通', -600, now() - interval '2 days', false),
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '云听音乐', '订阅', -1800, now() - interval '8 days', false),
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '星幕视频', '订阅', -2500, now() - interval '12 days', false),
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '安居物业', '居住', -380000, now() - interval '15 days', false),
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'TOKYO DIGITAL STORE', '购物', -129900, now() - interval '4 hours', true),
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '稳健理财收益', '投资', 12800, now() - interval '6 days', false);

INSERT INTO audit_events (customer_id, event_type, actor_type, event_summary, evidence) VALUES
('11111111-1111-4111-8111-111111111111', 'SESSION_AUTHENTICATED', 'SYSTEM', '受信任设备通过 Passkey 登录', '{"device":"iPhone 17 Pro","trust":"HIGH"}'),
('11111111-1111-4111-8111-111111111111', 'ANOMALY_DETECTED', 'RISK_ENGINE', '发现一笔与历史模式差异较大的境外消费', '{"merchant":"TOKYO DIGITAL STORE","amountMinor":-129900,"signals":["NEW_GEO","AMOUNT_DEVIATION"]}');

