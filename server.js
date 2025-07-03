// CORREÇÃO: Use 'require' em vez de 'import'
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || "5432"),
});

async function query(text, params) {
    const start = Date.now();
    try {
        const res = await pool.query(text, params);
        const duration = Date.now() - start;
        console.log('executed query', { text, duration, rows: res.rowCount });
        return res;
    } catch (error) {
        console.error('error in query', { text, error });
        throw error;
    }
}


// == AUTENTICAÇÃO ==
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
    }
    try {
        // ATENÇÃO: Em um app real, a senha NUNCA deve ser guardada como texto puro.
        // O ideal seria usar uma biblioteca como bcrypt para comparar hashes de senha.
        const result = await query(
            'SELECT id, nome, role, grupo_id FROM pessoas WHERE username = $1 AND password = $2',
            [username, password]
        );

        if (result.rowCount === 0) {
            return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
        }
        
        const user = result.rows[0];
        // Em um app real, aqui você geraria um token JWT.
        // Para simplificar, vamos retornar os dados do usuário.
        res.json({
            token: `fake-jwt-token-for-user-${user.id}`, // Token simulado
            user: user,
        });

    } catch (err) {
        console.error('[ERRO] Falha no login:', err);
        res.status(500).json({ error: 'Erro interno no servidor.' });
    }
});

// --- ROTAS ---

// == GRUPOS ==
app.get('/groups', async (req, res) => {
    try {
        const result = await query('SELECT * FROM grupos ORDER BY nome ASC', []);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao buscar grupos.' });
    }
});

app.post('/groups', async (req, res) => {
    const { nome, lider1_nome, lider2_nome, anfitriao1_nome, anfitriao2_nome } = req.body;
    if (!nome || !lider1_nome || !anfitriao1_nome) {
        return res.status(400).json({ error: 'Nome do grupo, nome do líder 1 e nome do anfitrião 1 são obrigatórios.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const createGroupQuery = `
            INSERT INTO grupos (nome, lider1_nome, lider2_nome, anfitriao1_nome, anfitriao2_nome) 
            VALUES ($1, $2, $3, $4, $5) 
            RETURNING *`;
        const groupResult = await client.query(createGroupQuery, [
            nome, lider1_nome, lider2_nome || null, anfitriao1_nome, anfitriao2_nome || null
        ]);
        const newGroup = groupResult.rows[0];
        const newGroupId = newGroup.id;

        const peopleMap = new Map();
        const addPersonToMap = (name, isLeader) => {
            if (name && name.trim() !== '') {
                const existing = peopleMap.get(name.trim());
                if (!existing || (existing.isLeader === false && isLeader === true)) {
                    peopleMap.set(name.trim(), { isLeader });
                }
            }
        };

        addPersonToMap(lider1_nome, true);
        addPersonToMap(lider2_nome, true);
        addPersonToMap(anfitriao1_nome, false);
        addPersonToMap(anfitriao2_nome, false);

        const createPersonQuery = `
            INSERT INTO pessoas (nome, eh_da_igreja, precisa_discipulado, precisa_batismo, eh_lider, grupo_id)
            VALUES ($1, true, false, false, $2, $3)
        `;
        
        for (const [name, role] of peopleMap.entries()) {
            await client.query(createPersonQuery, [name, role.isLeader, newGroupId]);
        }

        await client.query('COMMIT');
        res.status(201).json(newGroup);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[ERRO] Falha ao criar grupo (transação revertida):', err);
        res.status(500).json({ error: 'Erro interno ao criar grupo.' });
    } finally {
        client.release();
    }
});

// ROTA DE ATUALIZAÇÃO DE GRUPO (SUPER EDIÇÃO)
app.put('/groups/:id', async (req, res) => {
    const { id } = req.params;
    // Pega todos os campos que podem ser editados do corpo da requisição
    const { nome, lider1_nome, lider2_nome, anfitriao1_nome, anfitriao2_nome } = req.body;

    // Validação básica
    if (!nome || nome.trim() === '' || !lider1_nome || lider1_nome.trim() === '' || !anfitriao1_nome || anfitriao1_nome.trim() === '') {
        return res.status(400).json({ error: 'Nome do grupo, líder 1 e anfitrião 1 são obrigatórios.' });
    }

    try {
        const result = await query(
            `UPDATE grupos 
             SET nome = $1, lider1_nome = $2, lider2_nome = $3, anfitriao1_nome = $4, anfitriao2_nome = $5, data_atualizacao = CURRENT_TIMESTAMP 
             WHERE id = $6 RETURNING *`,
            [nome.trim(), lider1_nome.trim(), lider2_nome.trim() || null, anfitriao1_nome.trim(), anfitriao2_nome.trim() || null, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Grupo não encontrado.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('[ERRO] Falha ao atualizar grupo:', err);
        res.status(500).json({ error: 'Erro interno ao atualizar o grupo.' });
    }
});


app.delete('/groups/:id', async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM presencas WHERE grupo_id = $1', [id]);
        await client.query('UPDATE pessoas SET grupo_id = NULL WHERE grupo_id = $1', [id]);
        const resultDeleteGroup = await client.query('DELETE FROM grupos WHERE id = $1 RETURNING *', [id]);
        if (resultDeleteGroup.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Grupo não encontrado para deletar.' });
        }
        await client.query('COMMIT');
        res.json({ message: 'Grupo deletado com sucesso.', deletedGroup: resultDeleteGroup.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Erro ao deletar grupo (transação revertida):', err);
        res.status(500).json({ error: 'Erro interno ao deletar grupo.' });
    } finally {
        client.release();
    }
});

app.get('/groups/:id/meetings', async (req, res) => {
    const { id } = req.params;
    try {
        const historyQuery = `
            SELECT
                pr.data_reuniao,
                MAX(pr.observacoes) as observacoes,
                COUNT(*) as total_presentes,
                COUNT(*) FILTER (WHERE pr.status_na_reuniao = 'nova') as total_visitantes,
                json_agg(
                    json_build_object(
                        'pessoa_id', p.id, 
                        'nome_pessoa', p.nome
                    ) ORDER BY p.nome ASC
                ) as participantes
            FROM presencas pr
            JOIN pessoas p ON pr.pessoa_id = p.id
            WHERE pr.grupo_id = $1
            GROUP BY pr.data_reuniao
            ORDER BY pr.data_reuniao DESC;
        `;
        const result = await query(historyQuery, [id]);
        res.json(result.rows);
    } catch (err) {
        console.error('[ERRO] Falha ao buscar histórico de reuniões:', err);
        res.status(500).json({ error: 'Erro interno ao buscar histórico de reuniões.' });
    }
});

// == PESSOAS ==
app.get('/people', async (req, res) => {
    const { grupo_id, eh_lider } = req.query;
    try {
        let queryString = `
            SELECT p.*, g.nome as nome_grupo
            FROM pessoas p
            LEFT JOIN grupos g ON p.grupo_id = g.id
        `;
        const queryParams = [];
        const conditions = [];
        if (grupo_id) {
            queryParams.push(grupo_id);
            conditions.push(`p.grupo_id = $${queryParams.length}`);
        }
        if (eh_lider === 'true') {
            conditions.push(`p.eh_lider = TRUE`);
        }
        if (conditions.length > 0) {
            queryString += ' WHERE ' + conditions.join(' AND ');
        }
        queryString += ' ORDER BY p.nome ASC';
        const result = await query(queryString, queryParams);
        res.json(result.rows);
    } catch (err) {
        console.error('[ERRO] Falha ao buscar pessoas:', err);
        res.status(500).json({ error: 'Erro interno ao buscar pessoas.' });
    }
});

app.get('/people/search', async (req, res) => {
    const { name } = req.query;
    if (!name || name.trim().length < 3) {
        return res.json([]);
    }
    try {
        const searchQuery = `
            SELECT * FROM pessoas 
            WHERE nome ILIKE $1 
            LIMIT 5
        `;
        const result = await query(searchQuery, [`%${name}%`]);
        res.json(result.rows);
    } catch (err) {
        console.error('[ERRO] Falha na busca por nome de pessoa:', err);
        res.status(500).json({ error: 'Erro ao buscar pessoas por nome.' });
    }
});

app.get('/people/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await query(`
            SELECT p.*, g.nome as nome_grupo, l.nome as nome_lider_discipulador
            FROM pessoas p
            LEFT JOIN grupos g ON p.grupo_id = g.id
            LEFT JOIN pessoas l ON p.lider_discipulador_id = l.id
            WHERE p.id = $1
        `, [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Pessoa não encontrada.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao buscar pessoa.' });
    }
});

// ROTA DE CRIAR PESSOA ATUALIZADA para incluir dados de login
app.post('/people', async (req, res) => {
    const { nome, telefone, eh_da_igreja, precisa_discipulado, precisa_batismo, eh_lider, grupo_id, username, password, role } = req.body;
    
    if (!nome) {
        return res.status(400).json({ error: 'O nome da pessoa é obrigatório.' });
    }

    try {
        const result = await query(
            `INSERT INTO pessoas (nome, telefone, eh_da_igreja, precisa_discipulado, precisa_batismo, eh_lider, grupo_id, username, password, role)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [nome, telefone || null, eh_da_igreja, precisa_discipulado, precisa_batismo, eh_lider || false, grupo_id || null, username, password, role || 'leader']
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        if (err.code === '23505') { // unique_violation
             return res.status(409).json({ error: 'Este nome de usuário já está em uso.' });
        }
        res.status(500).json({ error: 'Erro ao criar pessoa.' });
    }
});

app.put('/people/:id', async (req, res) => {
    const { id } = req.params;
    const { nome, telefone, eh_da_igreja, precisa_discipulado, precisa_batismo, eh_lider, grupo_id, lider_discipulador_id, anotacoes } = req.body;
    const fieldsToUpdate = {};
    if (nome !== undefined) fieldsToUpdate.nome = nome;
    if (telefone !== undefined) fieldsToUpdate.telefone = telefone;
    if (eh_da_igreja !== undefined) fieldsToUpdate.eh_da_igreja = eh_da_igreja;
    if (precisa_discipulado !== undefined) fieldsToUpdate.precisa_discipulado = precisa_discipulado;
    if (precisa_batismo !== undefined) fieldsToUpdate.precisa_batismo = precisa_batismo;
    if (eh_lider !== undefined) fieldsToUpdate.eh_lider = eh_lider;
    if (grupo_id !== undefined) fieldsToUpdate.grupo_id = grupo_id;
    if (lider_discipulador_id !== undefined) fieldsToUpdate.lider_discipulador_id = lider_discipulador_id;
    if (anotacoes !== undefined) fieldsToUpdate.anotacoes = anotacoes;
    if (Object.keys(fieldsToUpdate).length === 0) {
        return res.status(400).json({ error: 'Nenhum campo fornecido para atualização.' });
    }
    const setClauses = Object.keys(fieldsToUpdate).map((key, index) => `${key} = $${index + 1}`).join(', ');
    const values = Object.values(fieldsToUpdate);
    values.push(id);
    try {
        const result = await query(
            `UPDATE pessoas SET ${setClauses}, data_atualizacao = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING *`,
            values
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Pessoa não encontrada.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao atualizar pessoa.' });
    }
});

app.delete('/people/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await query('DELETE FROM pessoas WHERE id = $1 RETURNING *', [id]);
        if (result.rowCount > 0) {
            res.json({ message: 'Pessoa deletada com sucesso.', deletedPerson: result.rows[0] });
        } else {
            res.status(404).json({ error: 'Pessoa não encontrada.' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Erro ao deletar pessoa.' });
    }
});

// NOVA ROTA PARA BUSCAR PESSOAS SEM GRUPO
app.get('/people/no-group', async (req, res) => {
    try {
        const result = await query('SELECT * FROM pessoas WHERE grupo_id IS NULL ORDER BY nome ASC', []);
        res.json(result.rows);
    } catch (err) {
        console.error('[ERRO] Falha ao buscar pessoas sem grupo:', err);
        res.status(500).json({ error: 'Erro interno ao buscar pessoas sem grupo.' });
    }
});

// == DISCIPULADO ==
app.get('/discipleship', async (req, res) => {
    try {
        // CORREÇÃO FINAL: Removida a coluna p.data_criacao que não existe.
        const sql = `
            SELECT
                p.id as pessoa_id,
                p.nome as pessoa_nome,
                p.precisa_discipulado,
                p.precisa_batismo,
                p.lider_discipulador_id,
                l.nome as lider_nome,
                g.nome as nome_grupo
            FROM pessoas p
            LEFT JOIN pessoas l ON p.lider_discipulador_id = l.id
            LEFT JOIN grupos g ON p.grupo_id = g.id
            WHERE (p.precisa_discipulado = TRUE OR p.precisa_batismo = TRUE) OR p.lider_discipulador_id IS NOT NULL
            ORDER BY p.nome ASC
        `;
        const result = await query(sql, []);
        res.json(result.rows);
    } catch (err) {
        console.error('[ERRO FATAL] em /discipleship:', err);
        res.status(500).json({ error: 'Erro interno ao buscar informações de discipulado.' });
    }
});

app.post('/discipleship/assign', async (req, res) => {
    const { pessoa_id, lider_id } = req.body;
    if (!pessoa_id || !lider_id) {
        return res.status(400).json({ error: 'pessoa_id e lider_id são obrigatórios.' });
    }
    try {
        const liderCheck = await query('SELECT eh_lider FROM pessoas WHERE id = $1', [lider_id]);
        if (liderCheck.rowCount === 0 || !liderCheck.rows[0].eh_lider) {
            return res.status(400).json({ error: 'Líder inválido ou não encontrado.' });
        }
        const result = await query(
            `UPDATE pessoas
             SET lider_discipulador_id = $1, data_atualizacao = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING id, nome, lider_discipulador_id, precisa_discipulado`,
            [lider_id, pessoa_id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Pessoa a ser discipulada não encontrada.' });
        }
        res.json({ message: 'Líder atribuído com sucesso.', assignment: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao atribuir líder.' });
    }
});

app.delete('/discipleship/assignment/:pessoa_id', async (req, res) => {
    const { pessoa_id } = req.params;
    try {
        const result = await query(
            `UPDATE pessoas
             SET lider_discipulador_id = NULL, data_atualizacao = CURRENT_TIMESTAMP
             WHERE id = $1 AND lider_discipulador_id IS NOT NULL
             RETURNING id, nome, lider_discipulador_id, precisa_discipulado`,
            [pessoa_id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Nenhuma atribuição de líder encontrada para esta pessoa.' });
        }
        res.json({ message: 'Atribuição de líder removida com sucesso.', unassignment: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao remover atribuição de líder.' });
    }
});

app.post('/discipleship/graduate/:person_id', async (req, res) => {
    const { person_id } = req.params;
    try {
        const result = await query(
            `UPDATE pessoas
             SET lider_discipulador_id = NULL, precisa_discipulado = FALSE, precisa_batismo = FALSE, data_atualizacao = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING *`,
            [person_id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Pessoa não encontrada.' });
        }
        res.json({ message: 'Pessoa graduada com sucesso.', person: result.rows[0] });
    } catch (err) {
        console.error('[ERRO] Falha ao graduar pessoa:', err);
        res.status(500).json({ error: 'Erro interno ao graduar pessoa.' });
    }
});

// == PRESENÇAS ==
app.post('/attendances', async (req, res) => {
    const { data_reuniao, grupo_id, pessoas_presentes, observacoes } = req.body;
    if (!data_reuniao || !grupo_id || !Array.isArray(pessoas_presentes) || pessoas_presentes.length === 0) {
        return res.status(400).json({ error: 'data_reuniao, grupo_id e um array de pessoas_presentes são obrigatórios.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const insertedAttendances = [];
        for (const p of pessoas_presentes) {
            const result = await client.query(
                `INSERT INTO presencas (data_reuniao, grupo_id, pessoa_id, status_na_reuniao, observacoes)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (data_reuniao, grupo_id, pessoa_id) DO UPDATE SET 
                    status_na_reuniao = EXCLUDED.status_na_reuniao,
                    observacoes = EXCLUDED.observacoes
                 RETURNING *`,
                [data_reuniao, grupo_id, p.pessoa_id, p.status_na_reuniao, observacoes || null]
            );
            if (result.rows.length > 0) {
                insertedAttendances.push(result.rows[0]);
            }
        }
        await client.query('COMMIT');
        res.status(201).json({ message: 'Presenças registradas com sucesso.', attendances: insertedAttendances });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Erro ao registrar presenças.' });
    } finally {
        client.release();
    }
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
