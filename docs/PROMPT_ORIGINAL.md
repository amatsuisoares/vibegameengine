# Prompt original do projeto

Pedido inicial que definiu o VibeGameEngine (sessão de 2026-09-30). É a referência de escopo e de
prioridades; o roadmap derivado dele está em [TODO.md](../TODO.md).

---

Quero desenvolver uma plataforma de criação de jogos 2D baseada em agentes de IA, inspirada no conceito de ferramentas como VibeGameDev/VibeGame.

O objetivo NÃO é simplesmente criar um chatbot que gera código. Quero criar um ambiente completo no qual um agente de IA consiga desenvolver um jogo 2D, executar o jogo, observar o resultado, interagir com ele e iterar sobre sua própria implementação.

## 1. OBJETIVO PRINCIPAL

Construir uma plataforma web/desktop de desenvolvimento de jogos 2D na qual o usuário possa conversar com um agente de IA em linguagem natural.

Exemplo:

"Crie um jogo de plataforma 2D. O personagem deve andar com A/D, pular com espaço, coletar moedas, enfrentar inimigos e chegar a uma bandeira no final da fase."

O agente deve ser capaz de:

1. interpretar o pedido;
2. planejar a implementação;
3. criar os objetos necessários;
4. criar/modificar código;
5. configurar a cena;
6. executar o jogo;
7. observar o jogo;
8. interagir com o jogo usando teclado e mouse;
9. detectar problemas;
10. modificar a implementação;
11. executar novamente;
12. repetir o processo até considerar que a tarefa foi concluída.

A ideia é criar um ciclo:

PROMPT
→ PLANEJAMENTO
→ IMPLEMENTAÇÃO
→ EXECUÇÃO
→ OBSERVAÇÃO
→ TESTE
→ CORREÇÃO
→ NOVO TESTE

## 2. ESCOPO INICIAL

Comece com uma engine 2D.

NÃO tente criar inicialmente uma engine 3D ou competir com Unity/Unreal/Godot em quantidade de funcionalidades.

O MVP deve suportar:

* sprites;
* GameObjects;
* cenas;
* câmera;
* movimentação;
* teclado;
* mouse;
* colisões;
* física básica;
* gravidade;
* animações;
* áudio básico;
* UI;
* texto;
* sistema de vida;
* pontuação;
* inimigos;
* checkpoints;
* troca de cenas/fases;
* condições e eventos.

A arquitetura deve permitir adicionar novos sistemas posteriormente.

## 3. STACK

Antes de implementar, avalie a stack mais adequada.

Uma possibilidade inicial é:

Frontend/editor:

* TypeScript
* React

Runtime 2D:

* Phaser

Backend:

* Node.js ou Python
* API REST/WebSocket conforme necessário

Persistência:

* JSON inicialmente
* banco de dados somente se realmente necessário

IA:

* arquitetura preparada para utilizar modelos de linguagem por API.

Não assuma que essas tecnologias são obrigatórias. Analise primeiro a arquitetura e explique brevemente se outra escolha for tecnicamente melhor.

## 4. EDITOR

Crie um editor visual semelhante a uma IDE de jogos.

A interface deve possuir:

* painel de hierarquia da cena;
* viewport do jogo;
* inspector de propriedades;
* gerenciamento de assets;
* editor de código;
* console/logs;
* painel de IA/chat;
* botão para executar;
* botão para parar;
* botão para testar;
* gerenciamento de cenas.

Uma estrutura aproximada:

```
┌────────────────────────────────────────────────────┐
│ File  Edit  Project  Run  Build                    │
├────────────┬───────────────────────┬───────────────┤
│ HIERARCHY  │                       │ INSPECTOR     │
│            │                       │               │
│ Player     │      GAME VIEW        │ Position      │
│ Enemy      │                       │ Sprite        │
│ Coin       │                       │ Physics       │
│ Camera     │                       │ Properties    │
│            │                       │               │
├────────────┴───────────────────────┴───────────────┤
│ CONSOLE / CODE / ASSETS                            │
├────────────────────────────────────────────────────┤
│ AI: "Adicione dois inimigos que sigam o jogador." │
└────────────────────────────────────────────────────┘
```

A interface não precisa ser exatamente assim, mas deve seguir essa lógica.

## 5. REPRESENTAÇÃO INTERNA DO JOGO

Crie uma representação estruturada do projeto.

Por exemplo:

```
Project
├── Scenes
├── Assets
├── Scripts
├── Prefabs
└── ProjectConfig
```

Cada cena deve possuir uma representação estruturada dos objetos.

Exemplo conceitual:

```json
{
  "scene": "Level1",
  "objects": [
    {
      "name": "Player",
      "type": "Character",
      "position": { "x": 100, "y": 300 },
      "components": ["Sprite", "Collider", "PhysicsBody", "PlayerController"]
    }
  ]
}
```

Não copie esse formato cegamente. Projete uma representação adequada e extensível.

## 6. SISTEMA DE AGENTE

O agente deve possuir ferramentas (tools) para manipular o projeto.

Crie uma arquitetura de ferramentas semelhante a:

```
create_game_object
delete_game_object
modify_game_object
create_scene
delete_scene
modify_scene
create_component
remove_component
modify_component
create_script
modify_script
delete_script
read_file
write_file
list_files
run_game
stop_game
restart_game
read_console
take_screenshot
inspect_game_state
send_keyboard_input
send_mouse_input
```

O agente deve conseguir decidir quais ferramentas utilizar.

NÃO faça o agente gerar todo o projeto novamente a cada mensagem.

Ele deve conseguir fazer alterações incrementais.

## 7. ACESSO AO CÓDIGO

O agente deve ter liberdade para criar e modificar código dentro do projeto.

Entretanto, mantenha uma arquitetura organizada.

O agente deve conseguir:

* criar arquivos;
* editar arquivos existentes;
* executar o projeto;
* ler erros;
* corrigir erros;
* executar novamente.

O sistema deve registrar todas as alterações feitas pelo agente.

Sempre que possível, mantenha histórico/diff das alterações.

## 8. EXECUÇÃO DO JOGO

O agente deve conseguir iniciar o jogo em um processo controlado.

Exemplo:

```
Agent
↓
run_game()
↓
Game Runtime
↓
Screenshot / Estado / Console
↓
Agent
```

O runtime deve permitir:

* iniciar;
* pausar;
* reiniciar;
* encerrar;
* capturar screenshots;
* obter logs;
* consultar estado do jogo.

## 9. CONTROLE DE TECLADO E MOUSE

Uma característica fundamental do projeto é permitir que o agente teste o próprio jogo.

O agente deve possuir ferramentas abstratas para:

```
move_mouse(x, y)
click_mouse(button)
press_key(key)
release_key(key)
wait(milliseconds)
```

Por exemplo:

```
press_key("D")
wait(1000)
release_key("D")
press_key("SPACE")
```

O objetivo é permitir que o agente jogue o jogo como um usuário.

IMPORTANTE:

Implemente isso inicialmente dentro de um ambiente controlado/sandbox.

Não dê ao agente acesso irrestrito ao computador inteiro.

O agente deve poder controlar somente o runtime/editor do projeto.

## 10. VISÃO DO AGENTE

O agente deve conseguir receber screenshots do jogo.

Fluxo:

```
take_screenshot()
↓
imagem
↓
modelo multimodal
↓
análise
↓
ação
```

Exemplo:

O agente cria uma plataforma.

Executa o jogo.

Observa a screenshot.

Percebe que o personagem não consegue alcançar a plataforma.

Então modifica a posição da plataforma.

Executa novamente.

Isso deve formar um loop de desenvolvimento iterativo.

## 11. LOOP AUTÔNOMO

Implemente uma estrutura conceitual como:

```
while (!task_completed):

    plan()

    implement()

    run_game()

    observe()

    test()

    if problem_detected:
        diagnose()

        fix()

        continue

    if task_completed:
        stop()
```

Não implemente um loop infinito.

O agente deve possuir:

* limite de iterações;
* timeout;
* orçamento de chamadas ao modelo;
* possibilidade de interromper;
* logs completos;
* confirmação opcional para ações destrutivas.

## 12. SISTEMA DE MEMÓRIA DO PROJETO

O agente precisa saber o estado atual do projeto.

Crie algum mecanismo para manter informações como:

* cenas existentes;
* objetos;
* scripts;
* assets;
* funcionalidades implementadas;
* tarefas pendentes;
* erros conhecidos;
* últimas alterações.

Não dependa apenas do histórico da conversa.

## 13. TERMINAL / CONSOLE

O agente deve conseguir ler os erros produzidos pelo jogo.

Exemplo:

```
ERROR:
Player.js:42
Cannot read property 'velocity' of undefined
```

O agente deve conseguir:

1. identificar o arquivo;
2. abrir o trecho relevante;
3. modificar;
4. executar novamente;
5. verificar se o erro desapareceu.

## 14. ASSETS

No MVP, permita:

* importar imagens;
* importar spritesheets;
* importar áudio;
* criar objetos usando esses assets.

Posteriormente podemos adicionar geração de assets por IA.

NÃO implemente geração de imagens por IA no primeiro MVP, a menos que isso seja trivial.

## 15. PRIMEIRO TESTE

Depois de criar a arquitetura, faça o próprio sistema criar automaticamente um pequeno jogo de plataforma.

Prompt de teste:

"Crie um jogo de plataforma 2D com um personagem controlável por A/D e espaço. Coloque plataformas, três moedas, dois inimigos e uma bandeira no final. O jogador ganha quando chega à bandeira e perde quando sua vida chega a zero."

O agente deverá:

1. criar a cena;
2. criar o jogador;
3. criar plataformas;
4. criar moedas;
5. criar inimigos;
6. criar a bandeira;
7. implementar os controles;
8. implementar colisões;
9. executar o jogo;
10. testar o movimento;
11. testar o pulo;
12. testar coleta de moedas;
13. testar inimigos;
14. testar condição de vitória;
15. corrigir erros encontrados.

## 16. PRINCÍPIO IMPORTANTE

Não tente implementar tudo de uma vez.

Primeiro:

1. arquitetura;
2. engine mínima;
3. editor mínimo;
4. runtime;
5. sistema de ferramentas;
6. agente;
7. execução;
8. screenshots;
9. teclado/mouse;
10. loop autônomo.

Cada etapa deve produzir algo executável.

## 17. DESENVOLVIMENTO INCREMENTAL

Antes de escrever grandes quantidades de código:

* analise o repositório;
* explique a arquitetura proposta;
* identifique riscos;
* proponha a estrutura de diretórios;
* implemente uma etapa;
* execute testes;
* corrija erros;
* somente então avance.

Não quero apenas código que "parece funcionar".

Quero que você execute o projeto e teste os componentes.

Sempre que possível, utilize testes automatizados.

## 18. DOCUMENTAÇÃO

Mantenha:

* README.md
* ARCHITECTURE.md
* AGENT_TOOLS.md
* TODO.md

Documente especialmente:

* arquitetura da engine;
* arquitetura do agente;
* ferramentas disponíveis;
* comunicação entre agente e runtime;
* sistema de screenshots;
* sistema de input;
* limitações atuais;
* próximos passos.

## 19. FILOSOFIA DO PROJETO

O objetivo final é chegar a algo como:

Usuário:

"Crie um jogo de plataforma estilo retrô em que um gato precisa coletar peixes enquanto foge de cachorros."

IA:

Planeja o jogo.

Cria os objetos.

Cria os scripts.

Executa.

Joga.

Observa.

Encontra problemas.

Corrige.

Joga novamente.

E finalmente entrega:

"Jogo criado e testado."

Quero que você trate esse projeto como uma plataforma de desenvolvimento de jogos baseada em um agente autônomo, e não apenas como um gerador de código.

COMECE AGORA.

Primeiro analise o ambiente/repositório atual, se houver.

Depois apresente:

1. arquitetura proposta;
2. stack recomendada;
3. estrutura de diretórios;
4. plano de implementação por etapas;
5. riscos técnicos;
6. primeiro MVP.

Depois disso, comece a implementar a primeira etapa.
