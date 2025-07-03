// ROTA PARA ATUALIZAR UM GRUPO (PUT)
app.put('/groups/:id', async (req, res) => {
    const { id } = req.params;
    const { nome } = req.body; // Pega apenas o 'nome' do corpo da requisição

    // Validação simples para garantir que o nome não seja vazio
    if (!nome || nome.trim() === '') {
        return res.status(400).json({ error: 'O nome do grupo não pode ser vazio.' });
    }

    try {
        const result = await query(
            'UPDATE grupos SET nome = $1, data_atualizacao = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
            [nome, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Grupo não encontrado.' });
        }

        console.log(`[LOG] Grupo ID ${id} atualizado para "${nome}".`);
        res.json(result.rows[0]); // Retorna o grupo atualizado

    } catch (err) {
        console.error('[ERRO] Falha ao atualizar grupo:', err);
        res.status(500).json({ error: 'Erro interno ao atualizar o grupo.' });
    }
});