module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({
            error: 'GEMINI_API_KEY is not configured in Vercel Environment Variables.'
        });
    }

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        let { imageBase64, mimeType } = body;

        if (!imageBase64 || typeof imageBase64 !== 'string') {
            return res.status(400).json({ error: 'Missing receipt image data.' });
        }

        // Strip data URL prefix if present (e.g. "data:image/jpeg;base64,...")
        const dataUrlMatch = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
        if (dataUrlMatch) {
            mimeType = mimeType || dataUrlMatch[1];
            imageBase64 = dataUrlMatch[2];
        }

        const safeMimeType = mimeType || 'image/jpeg';

        const categories = [
            'Groceries',
            'Dining',
            'Coffee & Snacks',
            'Fuel & Auto',
            'Clothing',
            'Shopping',
            'Home & Living',
            'Bills & Utilities',
            'Subscriptions',
            'Health & Fitness',
            'Personal Care',
            'Travel',
            'Entertainment',
            'Gifts',
            'Other'
        ];

        const prompt = [
            'Analyze this receipt image and extract the expense details.',
            'Rules:',
            '- merchant: Clean store, restaurant, or vendor name (e.g. "Costco", "Sheetz", "Target").',
            '- amount: Final total amount paid (including tax and tip if shown) as a positive number.',
            '- date: Transaction date in YYYY-MM-DD format if clearly visible; otherwise empty string "".',
            '- category: Choose the single best matching category from the allowed enum list.',
            '- payment: Payment method if shown on receipt ("Apple Pay", "Google Pay", "Credit Card", "Debit Card", "Cash", "Gift Card"), otherwise empty string "".',
            '- note: Short, helpful summary of 1 to 3 key items purchased (under 60 characters), or empty string "" if unreadable.'
        ].join('\n');

        const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

        const geminiResponse = await fetch(geminiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify({
                contents: [
                    {
                        role: 'user',
                        parts: [
                            { text: prompt },
                            {
                                inlineData: {
                                    mimeType: safeMimeType,
                                    data: imageBase64
                                }
                            }
                        ]
                    }
                ],
                generationConfig: {
                    temperature: 0.1,
                    responseMimeType: 'application/json',
                    responseSchema: {
                        type: 'OBJECT',
                        properties: {
                            merchant: { type: 'STRING' },
                            amount: { type: 'NUMBER' },
                            date: { type: 'STRING' },
                            category: {
                                type: 'STRING',
                                enum: categories
                            },
                            payment: { type: 'STRING' },
                            note: { type: 'STRING' }
                        },
                        required: ['merchant', 'amount', 'date', 'category', 'payment', 'note']
                    }
                }
            })
        });

        const rawResult = await geminiResponse.json();

        if (!geminiResponse.ok) {
            const apiErrMsg = rawResult?.error?.message || `Gemini API error (${geminiResponse.status})`;
            return res.status(geminiResponse.status).json({ error: apiErrMsg });
        }

        const textOutput = rawResult?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!textOutput) {
            return res.status(502).json({ error: 'Gemini returned an empty response for this receipt.' });
        }

        const extracted = JSON.parse(textOutput);
        return res.status(200).json({
            merchant: String(extracted.merchant || '').trim(),
            amount: Number(extracted.amount) || 0,
            date: String(extracted.date || '').trim(),
            category: categories.includes(extracted.category) ? extracted.category : 'Other',
            payment: String(extracted.payment || '').trim(),
            note: String(extracted.note || '').trim()
        });
    } catch (err) {
        console.error('Receipt scan failed:', err);
        return res.status(500).json({
            error: err.message || 'Unexpected error scanning receipt.'
        });
    }
};

