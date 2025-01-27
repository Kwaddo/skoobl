package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
	"github.com/gorilla/handlers"
)

var (
	games       sync.Map
	upgrader    = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }} // Allow connections from any origin
	gameClients = sync.Map{} // Map to hold WebSocket connections for each game code
)

// GenerateGameCode generates a unique 6-character game code
func GenerateGameCode() string {
	bytes := make([]byte, 3) // 3 bytes = 6 hex characters
	_, err := rand.Read(bytes)
	if err != nil {
		panic(err)
	}
	return hex.EncodeToString(bytes)
}

// CreateGame creates a new game and returns the game code
func CreateGame(w http.ResponseWriter, r *http.Request) {
	code := GenerateGameCode()
	games.Store(code, map[string]interface{}{"players": []string{}})
	fmt.Fprintf(w, "Game code: %s", code)
}

// Handle WebSocket connections for the game
func HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Get the game code from the query parameters
	code := r.URL.Query().Get("code")

	// Upgrade the HTTP connection to a WebSocket connection
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("WebSocket upgrade failed:", err)
		return
	}
	defer conn.Close()

	// Add the new connection to the gameClients map
	gameClients.Store(code, conn)

	// Send the initial player list to the new client
	game, ok := games.Load(code)
	if ok {
		players := game.(map[string]interface{})["players"].([]string)
		err := conn.WriteJSON(players)
		if err != nil {
			log.Println("Error sending initial player list:", err)
			return
		}
	}

	// Wait for new players to join and send updates to all clients
	for {
		_, _, err := conn.ReadMessage() // Wait for a message (this just keeps the connection alive)
		if err != nil {
			log.Println("Error reading message:", err)
			gameClients.Delete(code)
			break
		}
	}
}

// JoinGame adds a player to the game and broadcasts the updated list of players to all clients
func JoinGame(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	playerName := r.URL.Query().Get("player")

	// Check if game exists
	game, ok := games.Load(code)
	if !ok {
		http.Error(w, "Game not found", http.StatusNotFound)
		return
	}

	// Add player to the game
	gameState := game.(map[string]interface{})
	players := gameState["players"].([]string)
	players = append(players, playerName)
	gameState["players"] = players

	// Save the updated game state
	games.Store(code, gameState)

	// Broadcast the updated player list to all connected clients
	gameClients.Range(func(key, value interface{}) bool {
		conn := value.(*websocket.Conn)
		err := conn.WriteJSON(players) // Send the updated player list to each client
		if err != nil {
			log.Println("Error sending player list update:", err)
			conn.Close()
			gameClients.Delete(key)
		}
		return true
	})

	// Respond with the updated list of players as JSON
	w.Header().Set("Content-Type", "application/json")
	err := json.NewEncoder(w).Encode(players)
	if err != nil {
		http.Error(w, "Failed to encode players", http.StatusInternalServerError)
	}
}

func main() {
	// CORS configuration
	headers := handlers.AllowedHeaders([]string{"X-Requested-With", "Content-Type"})
	origins := handlers.AllowedOrigins([]string{"*"})
	methods := handlers.AllowedMethods([]string{"GET", "POST", "OPTIONS"})

	http.HandleFunc("/create-game", CreateGame)
	http.HandleFunc("/join-game", JoinGame)
	http.HandleFunc("/ws", HandleWebSocket) // WebSocket endpoint for real-time updates

	// Apply CORS middleware
	log.Println("Starting server on port 8080")
	http.ListenAndServe(":8080", handlers.CORS(origins, headers, methods)(http.DefaultServeMux))
}
