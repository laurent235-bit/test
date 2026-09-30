// ============================================================
// CHEF LIBRE — composition ouverte avec verification
// Gemini compose a partir de l'inventaire complet,
// puis on verifie que les plats proposes sont realisables
// ============================================================


// ============================================================
// 1. CONTEXTE STOCK ENRICHI
// On donne a Gemini tout ce qu'il faut pour cuisiner
// ============================================================
async function construireContexteStock() {
    const { data: produits } = await monSupabase
        .from('inventaire2')
        .select('nom, quantite, emplacement, etat, date_peremption')
        .eq('proprietaire', utilisateurActuel)
        .neq('etat', 'Vide');

    if (!produits?.length) return null;

    const nomsProduits = produits.map(function(p) {
        return p.nom.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    });

    // Produits a finir en priorite
    const urgents = produits.filter(function(p) {
        if (p.etat === 'Entamé') return true;
        if (!p.date_peremption) return false;
        const jours = Math.ceil((new Date(p.date_peremption) - new Date()) / 86400000);
        return jours <= 3;
    });

    // Regrouper par emplacement avec les quantites
    const parLieu = function(lieu) {
        return produits
            .filter(function(p) { return p.emplacement === lieu; })
            .map(function(p) {
                const marque = p.etat === 'Entamé' ? ' (entamé)' : '';
                return p.nom + marque;
            })
            .join(', ') || 'vide';
    };

    return {
        produits: produits,
        nomsProduits: nomsProduits,
        urgents: urgents,
        texte: `FRIGO : ${parLieu('FRIGO')}
CONGÉLATEUR : ${parLieu('CONGELATEUR')}
PLACARD : ${parLieu('PLACARD')}

À FINIR EN PRIORITÉ : ${urgents.map(function(p) { return p.nom; }).join(', ') || 'rien d urgent'}`
    };
}


// ============================================================
// 2. RECETTES DE LA BASE — comme inspiration, pas comme contrainte
// ============================================================
async function chargerInspirations(mode, contexte) {
    const { data: recettes } = await monSupabase
        .from('recettes_chef')
        .select('nom, mode, ingredients_cles, temps_minutes')
        .eq('mode', mode)
        .eq('actif', true);

    if (!recettes) return [];

    const basiques = ['sel', 'poivre', 'huile', 'eau', 'beurre', 'sucre',
                      'farine', 'ail', 'oignon', 'bouillon', 'vinaigrette',
                      'mayonnaise', 'vanille', 'curry', 'vin', 'lait'];

    // Ne garder que celles realisables, pour inspirer
    const realisables = recettes.filter(function(r) {
        const necessaires = r.ingredients_cles.filter(function(i) {
            return basiques.indexOf(i) === -1;
        });
        return necessaires.every(function(ing) {
            return matchIngredient(ing, contexte.nomsProduits);
        });
    });

    realisables.sort(function() { return Math.random() - 0.5; });
    return realisables.slice(0, 10);
}


// ============================================================
// 3. ENVOYER UN MESSAGE — version composition libre
// ============================================================
async function envoyerMessageChef(modeForce) {
    const input = document.getElementById('chef-message');
    const message = input.value.trim();
    if (!message) return;

    if (!utilisateurActuel) {
        utilisateurActuel = localStorage.getItem('monFrigo_User');
    }
    if (!utilisateurActuel) {
        afficherToast('Connecte-toi d abord');
        return;
    }

    const statut = document.getElementById('statut-chef');
    const zone = document.getElementById('chef-conversation');

    input.value = '';
    zone.style.display = 'block';
    ajouterBulleChef(message, 'moi');
    statut.innerText = '👨‍🍳 Le Chef réfléchit...';

    try {
        contexteStock = await construireContexteStock();

        if (!contexteStock) {
            ajouterBulleChef("Ton stock est vide. Scanne un ticket de caisse pour commencer.", 'chef');
            statut.innerText = '';
            return;
        }

        const mode = modeForce || detecterModeMessage(message);
        const inspirations = await chargerInspirations(mode, contexteStock);

        const prompt = construirePromptLibre(message, contexteStock, mode, inspirations);

        let reponse = null;
        let tentatives = 0;
        while (!reponse && tentatives < 3) {
            try {
                reponse = await appelGemini({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.9 }
                });
            } catch(e) {
                tentatives++;
                if (tentatives < 3) {
                    statut.innerText = `⏳ Réessai ${tentatives}/3...`;
                    await new Promise(r => setTimeout(r, 2500));
                } else {
                    throw e;
                }
            }
        }

        conversationChef.push({ role: 'moi', texte: message });
        conversationChef.push({ role: 'chef', texte: reponse });
        if (conversationChef.length > 14) {
            conversationChef = conversationChef.slice(-14);
        }

        ajouterBulleChef(reponse, 'chef');

        window.dernieresPropositions = reponse;
        window.attenteChoixRecette = true;
        window.modeChefActuel = mode;

        statut.innerText = '';

        if (!document.getElementById('mode-silencieux')?.checked) {
            faireParlerIA(reponse);
        }

    } catch (err) {
        console.error('Erreur Chef :', err);
        ajouterBulleChef("Désolé, j'ai eu un problème. Réessaie dans quelques secondes.", 'chef');
        statut.innerText = '';
    }
}


// ============================================================
// 4. PROMPT DE COMPOSITION LIBRE
// ============================================================
function construirePromptLibre(message, contexte, mode, inspirations) {

    // Historique de conversation
    let historique = '';
    let dejaCites = '';
    if (conversationChef.length > 0) {
        historique = '\nCONVERSATION EN COURS :\n'
            + conversationChef.map(function(c) {
                return (c.role === 'moi' ? 'Utilisateur : ' : 'Toi : ') + c.texte;
              }).join('\n') + '\n';

        dejaCites = `
Tu as déjà proposé des plats plus haut dans cette conversation.
Si l'utilisateur demande autre chose, propose des plats VRAIMENT différents :
change de viande, de féculent ou de mode de cuisson. Ne reformule pas.
Si tu as fait le tour des possibilités raisonnables, dis-le honnêtement
plutôt que de te répéter.
`;
    }

    // Inspirations issues de la base
    let bloc = '';
    if (inspirations.length > 0) {
        bloc = '\nQUELQUES IDÉES DE LA BASE (simples pistes, tu n es pas obligé de les suivre) :\n'
             + inspirations.map(function(r) {
                 return '- ' + r.nom + ' (' + r.temps_minutes + ' min)';
               }).join('\n') + '\n';
    }

    const contextesModes = {
        quotidien: `C'est un soir de semaine. L'utilisateur veut quelque chose de simple
et rapide, moins de 25 minutes. Dans la cuisine familiale française du quotidien,
un repas c'est souvent une protéine, un féculent et un légume dans la même assiette :
steak haché frites haricots verts, cordon bleu riz petits pois, poisson pané purée.
Ou un plat unique classique : croque-monsieur, coquillettes au jambon, omelette,
quiche, pâtes carbonara, hachis parmentier.`,

        weekend: `C'est le week-end, l'utilisateur a du temps devant lui.
Il peut faire un plat qui mijote, un rôti, un gratin, quelque chose de généreux.`,

        cookeo: `L'utilisateur veut cuisiner au Cookeo, un multicuiseur sous pression.
Propose des plats adaptés : mijotés express, riz et pâtes en cuisson unique,
légumes vapeur, soupes.`,

        healthy: `L'utilisateur veut manger léger et équilibré.
Privilégie les légumes, les protéines maigres, les cuissons douces.`,

        monde: `L'utilisateur veut changer du quotidien français.
Propose des plats inspirés d'autres cuisines, mais réalisables avec ce qu'il a.`,

        dessert: `L'utilisateur veut un dessert.`,

        antigaspi: `L'utilisateur veut utiliser en priorité ce qui doit être mangé
rapidement. Construis les propositions autour des produits à finir.`
    };

    return `Tu es le Chef, un cuisinier familier et débrouillard.
Tu connais la cuisine française du quotidien et tu sais improviser.

${contextesModes[mode] || contextesModes.quotidien}

VOICI EXACTEMENT CE QUE L'UTILISATEUR A CHEZ LUI :
${contexte.texte}
${bloc}${historique}${dejaCites}
DEMANDE DE L'UTILISATEUR : "${message}"

TON RÔLE :
Tu composes librement des repas à partir de ce stock. Tu n'es pas limité à une
liste de recettes : si l'utilisateur a du jarret, des salsifis et du quinoa,
tu sais quoi en faire. Utilise ton savoir de cuisinier.

RÈGLE ABSOLUE — LES INGRÉDIENTS :
Tu ne peux utiliser QUE les produits listés ci-dessus, plus les basiques que
tout le monde a : sel, poivre, huile, beurre, eau, ail, oignon, farine, sucre.
Si un plat demande un ingrédient absent de la liste, tu ne le proposes pas,
OU tu le proposes en disant clairement ce qui manque.
Ne prétends JAMAIS qu'un produit est disponible s'il n'est pas dans la liste.

COMMENT RÉPONDRE :

- Si l'utilisateur pose une QUESTION sur son stock, réponds factuellement.
- S'il ANNONCE ce qu'il va faire, accompagne-le : confirme qu'il a ce qu'il faut,
  ou dis ce qui manque, propose un accompagnement. Ne propose pas autre chose
  à la place.
- S'il DEMANDE DES IDÉES, propose 3 repas différents et termine par
  "Lequel te tente ?"

VARIÉTÉ :
Les 3 propositions doivent être franchement différentes : pas la même viande,
pas le même féculent, pas le même type de plat.

NOMS DES PLATS :
Le stock contient des noms bruts de tickets de caisse, laids et techniques.
N'utilise jamais ces noms tels quels.
Écris "des boulettes de boeuf", pas "MAX. BOUL. BOEUF CHARAL X30 900G".
Écris "une crème au chocolat", pas "Danette Liégeois chocolat".

PRODUITS À FINIR :
Si un plat permet d'utiliser un produit de la liste "à finir en priorité",
mentionne-le brièvement. Sinon, n'en parle pas.
Ne dis jamais qu'un plat finit un produit qui n'y entre pas vraiment.

STYLE :
Trois phrases maximum. Ton naturel, direct, comme un pote qui cuisine bien.
Pas de markdown, pas de gras, pas de listes à puces.`;
}
