"use client";
import { useEffect } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import styles from "./VenueMap.module.css";

interface Venue {
  id: string;
  name: string;
  neighborhood: string;
  lat: number;
  lng: number;
}

// Webpack mangles leaflet's default icon paths — fix by pointing at the CDN copies
const defaultIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

interface VenueMapProps {
  venues: Venue[];
  onVenueClick: (id: string) => void;
}

export default function VenueMap({ venues, onVenueClick }: VenueMapProps) {
  useEffect(() => {
    L.Marker.prototype.options.icon = defaultIcon;
  }, []);

  const withCoords = venues.filter((v) => v.lat != null && v.lng != null);
  if (withCoords.length === 0) return null;

  const centerLat = withCoords.reduce((s, v) => s + v.lat!, 0) / withCoords.length;
  const centerLng = withCoords.reduce((s, v) => s + v.lng!, 0) / withCoords.length;

  return (
    <div className={styles.mapWrap}>
      <MapContainer
        center={[centerLat, centerLng]}
        zoom={13}
        className={styles.map}
        scrollWheelZoom={false}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {withCoords.map((venue) => (
          <Marker key={venue.id} position={[venue.lat!, venue.lng!]}>
            <Popup>
              <strong>{venue.name}</strong>
              <br />
              {venue.neighborhood}
              <br />
              <button
                onClick={() => onVenueClick(venue.id)}
                className={styles.popupBtn}
              >
                Show only this venue
              </button>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
