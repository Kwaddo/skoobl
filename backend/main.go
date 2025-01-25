package main

import (
	"encoding/json"
	"log"
	"net/http"
)

type Response struct {
    Message string `json:"message"`
}

func main() {
    http.HandleFunc("/api/hello", func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(Response{Message: "Howdy from Go!"})
    })

	log.Println("Server started on :8080")
    http.ListenAndServe(":8080", nil)
}
