package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/handlers"
	"github.com/gorilla/websocket"
)

var (
	games       sync.Map // Stores game state for each game code
	upgrader    = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	gameClients = sync.Map{} // 🔥 Map storing WebSocket connections per game
)

type GameState struct {
	Players []string `json:"players"`
	Host    string   `json:"host"`
}

// 🔹 Generates a unique 6-character game code
func GenerateGameCode() string {
	bytes := make([]byte, 3)
	_, err := rand.Read(bytes)
	if err != nil {
		panic(err)
	}
	return hex.EncodeToString(bytes)
}

// 🔹 Broadcasts message to ALL WebSocket clients in a game
func BroadcastToGame(gameCode string, message interface{}) {
	if clients, ok := gameClients.Load(gameCode); ok {
		clientList := clients.([]*websocket.Conn)

		for _, conn := range clientList {
			if err := conn.WriteJSON(message); err != nil {
				log.Printf("Error broadcasting to client: %v", err)
				conn.Close()
			}
		}
	}
}

// 🔹 Creates a new game
func CreateGame(w http.ResponseWriter, r *http.Request) {
	code := GenerateGameCode()
	gameState := GameState{
		Players: []string{},
		Host:    "", // Will be set when host connects
	}
	games.Store(code, gameState)

	// 🔥 Initialize empty WebSocket client list for this game
	gameClients.Store(code, []*websocket.Conn{})

	fmt.Fprintf(w, "Game Code: %s", code)
}

// 🔹 Adds a player to the game
func JoinGame(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	playerName := r.URL.Query().Get("player")

	gameInterface, exists := games.Load(code)
	if !exists {
		http.Error(w, "Game not found", http.StatusNotFound)
		return
	}

	gameState, ok := gameInterface.(GameState)
	if !ok {
		http.Error(w, "Invalid game state", http.StatusInternalServerError)
		return
	}

	// Prevent duplicate player names
	for _, existingPlayer := range gameState.Players {
		if existingPlayer == playerName {
			http.Error(w, "Player name already taken", http.StatusConflict)
			return
		}
	}

	// ✅ Add player and update game state
	gameState.Players = append(gameState.Players, playerName)
	games.Store(code, gameState)

	// 🔥 Broadcast updated player list to ALL WebSocket clients
	BroadcastToGame(code, gameState)

	// ✅ Send response
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(gameState.Players)
}

// 🔹 Deletes a game and kicks everyone out
func DeleteGame(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")

	// ✅ Check if game exists
	if _, exists := games.Load(code); !exists {
		http.Error(w, "Game not found", http.StatusNotFound)
		return
	}

	// 🔥 Broadcast "game-ended" message
	BroadcastToGame(code, map[string]string{"type": "game-ended"})

	// 🔹 Remove game and WebSocket clients
	games.Delete(code)
	gameClients.Delete(code)

	w.WriteHeader(http.StatusOK)
}

// 🔹 Manages WebSocket connections
func HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	playerName := r.URL.Query().Get("player")

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	// 🔹 Add WebSocket connection to game
	if clients, ok := gameClients.Load(code); ok {
		clientList := clients.([]*websocket.Conn)
		gameClients.Store(code, append(clientList, conn))
	}

	// 🔹 Send initial game state
	if gameInterface, exists := games.Load(code); exists {
		gameState, ok := gameInterface.(GameState)
		if ok {
			if err := conn.WriteJSON(gameState); err != nil {
				log.Printf("Error sending initial state: %v", err)
				return
			}
		}
	}

	// 🔹 Handle WebSocket disconnect
	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			log.Printf("WebSocket read error: %v", err)

			// 🔥 Remove connection from client list
			if clients, ok := gameClients.Load(code); ok {
				clientList := clients.([]*websocket.Conn)
				for i, c := range clientList {
					if c == conn {
						clientList = append(clientList[:i], clientList[i+1:]...)
						break
					}
				}
				gameClients.Store(code, clientList)
			}

			// 🔹 Remove player from game state
			if gameInterface, exists := games.Load(code); exists {
				gameState, ok := gameInterface.(GameState)
				if ok {
					for i, player := range gameState.Players {
						if player == playerName {
							gameState.Players = append(gameState.Players[:i], gameState.Players[i+1:]...)
							break
						}
					}
					games.Store(code, gameState)

					// 🔥 Broadcast updated player list
					BroadcastToGame(code, gameState)
				}
			}
			break
		}
	}
}

func main() {
	// CORS configuration
	headers := handlers.AllowedHeaders([]string{"X-Requested-With", "Content-Type", "Authorization"})
	origins := handlers.AllowedOrigins([]string{"*"})
	methods := handlers.AllowedMethods([]string{"GET", "POST", "PUT", "DELETE", "OPTIONS"})

	// Register handlers
	http.HandleFunc("/create-game", CreateGame)
	http.HandleFunc("/join-game", JoinGame)
	http.HandleFunc("/ws", HandleWebSocket)
	http.HandleFunc("/delete-game", DeleteGame)

	// Start server
	port := ":8080"
	log.Printf("Starting server on port %s", port)
	log.Fatal(http.ListenAndServe(port, handlers.CORS(origins, headers, methods)(http.DefaultServeMux)))
}
